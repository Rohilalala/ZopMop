// Phase 10 — Pro-side job lifecycle endpoints. Mounted under
// /api/v1/pro/jobs/* by cmd/api/main.go behind AuthMiddleware +
// RequireRole("pro") + proApprovedMW.
//
// These endpoints are thin wrappers over the existing booking
// service for the actions that already exist (accept, start,
// complete) and add three new capabilities:
//
//   - en-route: stamps en_route_at + fires customer push. Status
//     stays 'accepted' — the timestamp itself signals sub-state.
//   - arrived (GPS-gated): the existing MarkArrived path with a
//     server-side check that the pro's GPS is within 100m of the
//     booking address.
//   - per-service start / complete / skip: progress within a job.
//
// The legacy /api/v1/bookings/:id/{accept,arrived,start,complete}
// endpoints still work; pro app should migrate to /pro/jobs/* over
// time. Both paths share the same underlying state machine.

package booking

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// ArrivedRadiusMeters caps how far a pro can be from the booking
// address when calling /arrived. Server-side gate — pro app's
// in-zone check is decorative.
const ArrivedRadiusMeters = 100.0

var (
	ErrOutsideArrivedRadius = errors.New("too far from customer location to mark arrived")
	ErrJobNotInState        = errors.New("job is not in the expected state for this transition")
	ErrServiceNotFound      = errors.New("service line not found on this booking")
	// Phase 11A contact reveal — distinct errors so handler can map to
	// 403 vs 409 cleanly. Forbidden = booking not assigned to this pro;
	// InvalidState = pre-accept / post-complete / cancelled / etc.
	ErrContactForbidden    = errors.New("not assigned to this booking")
	ErrContactInvalidState = errors.New("booking not in a state that allows contact reveal")
	// ErrContactAuditFailed — the pro_contact_reveals audit row could not
	// be persisted. Migration 102 mandates the audit row before any
	// unmasked-phone disclosure, so this maps to 500 and returns NO PII.
	ErrContactAuditFailed = errors.New("contact reveal audit write failed")
)

// ContactResponse is the body returned by POST /pro/jobs/:id/contact.
// Phone is the unmasked 10-digit national number (no +91 prefix) so the
// pro app can hand it directly to Linking.openURL('tel:…').
type ContactResponse struct {
	CustomerPhone string `json:"customer_phone"`
	CustomerName  string `json:"customer_name"`
}

// JobsHandler is the /pro/jobs/* surface. Lives next to the existing
// booking Handler so we share the service + repo.
type JobsHandler struct {
	service *Service
}

func NewJobsHandler(service *Service) *JobsHandler {
	return &JobsHandler{service: service}
}

// RegisterRoutes mounts /pro/jobs/* onto a group that's already
// gated by AuthMiddleware + RequireRole("pro") + proApprovedMW.
func (h *JobsHandler) RegisterRoutes(r fiber.Router) {
	r.Get("/active", h.Active)
	r.Get("/pending", h.Pending)
	r.Post("/:id/accept", h.Accept)
	r.Post("/:id/en-route", h.EnRoute)
	r.Post("/:id/arrived", h.Arrived)
	r.Post("/:id/start", h.Start)
	r.Post("/:id/complete", h.Complete)
	r.Post("/:id/contact", h.RevealContact)
	r.Post("/:id/services/:service_id/start", h.ServiceStart)
	r.Post("/:id/services/:service_id/complete", h.ServiceComplete)
	r.Post("/:id/services/:service_id/skip", h.ServiceSkip)
}

// ─── Handlers ───────────────────────────────────────────────────────

func (h *JobsHandler) Active(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	rows, err := h.service.repo.GetHelperActiveBookings(c.UserContext(), helperID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load active jobs"})
	}
	return c.JSON(fiber.Map{"bookings": rows})
}

func (h *JobsHandler) Pending(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	ids, err := h.service.GetHelperInvites(c.UserContext(), helperID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load pending offers"})
	}
	return c.JSON(fiber.Map{"booking_ids": ids})
}

func (h *JobsHandler) Accept(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	if err := h.service.AcceptBooking(c.UserContext(), bookingID, helperID); err != nil {
		log.Warn().Err(err).Str("booking_id", bookingID).Msg("[jobs] accept failed")
		return mapAcceptError(c, err)
	}
	return c.JSON(fiber.Map{"message": "accepted"})
}

type enRouteRequest struct {
	Lat float64 `json:"lat" validate:"required,latitude"`
	Lng float64 `json:"lng" validate:"required,longitude"`
}

func (h *JobsHandler) EnRoute(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	var req enRouteRequest
	_ = c.BodyParser(&req) // lat/lng optional — used for ETA hints only
	if err := h.service.MarkEnRoute(c.UserContext(), bookingID, helperID); err != nil {
		if errors.Is(err, ErrJobNotInState) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to mark en-route"})
	}
	return c.JSON(fiber.Map{"message": "en_route"})
}

type arrivedRequest struct {
	Lat float64 `json:"lat" validate:"required,latitude"`
	Lng float64 `json:"lng" validate:"required,longitude"`
}

func (h *JobsHandler) Arrived(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	var req arrivedRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if err := h.service.MarkArrivedGated(c.UserContext(), bookingID, helperID, req.Lat, req.Lng); err != nil {
		if errors.Is(err, ErrOutsideArrivedRadius) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "too far from customer location",
				"code":  "OUTSIDE_ARRIVED_RADIUS",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to mark arrived"})
	}
	return c.JSON(fiber.Map{"message": "arrived"})
}

func (h *JobsHandler) Start(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	if err := h.service.StartBooking(c.UserContext(), bookingID, helperID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"message": "in_progress"})
}

func (h *JobsHandler) Complete(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	if err := h.service.CompleteBooking(c.UserContext(), bookingID, helperID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	// Read back the earnings snapshot for the response.
	var earnings int64
	var actualMin int
	_ = h.service.db.QueryRow(c.UserContext(),
		`SELECT COALESCE(pro_earnings_paise, 0), COALESCE(actual_duration_minutes, 0)
		   FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(&earnings, &actualMin)
	return c.JSON(fiber.Map{
		"message":                 "completed",
		"pro_earnings_paise":      earnings,
		"actual_duration_minutes": actualMin,
	})
}

// RevealContact handles POST /pro/jobs/:id/contact. The assigned pro asks
// for the customer's unmasked phone + name to call them mid-job. Each call
// inserts a pro_contact_reveals audit row.
//
// Authorization:
//   - JWT must belong to the booking's assigned helper (helper_id check)
//   - Booking status must be one of accepted | arrived | in_progress
//
// Returns 403 for the IDOR case (with intentionally vague body so we don't
// leak booking existence), 409 INVALID_STATE otherwise.
func (h *JobsHandler) RevealContact(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	userAgent := c.Get("User-Agent")

	contact, err := h.service.RevealCustomerContact(c.UserContext(), bookingID, helperID, userAgent)
	if err != nil {
		switch {
		case errors.Is(err, ErrContactForbidden):
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error":      "not your booking",
				"error_code": "FORBIDDEN",
			})
		case errors.Is(err, ErrContactInvalidState):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":      "booking not in a state that allows contact reveal",
				"error_code": "INVALID_STATE",
			})
		case errors.Is(err, ErrContactAuditFailed):
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error":   "audit_write_failed",
				"message": "Contact reveal failed. Please try again.",
			})
		default:
			log.Error().Err(err).Str("booking_id", bookingID).Msg("[jobs] contact reveal failed")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to reveal contact"})
		}
	}
	return c.JSON(contact)
}

func (h *JobsHandler) ServiceStart(c *fiber.Ctx) error {
	return h.serviceTransition(c, "in_progress", "started_at")
}

func (h *JobsHandler) ServiceComplete(c *fiber.Ctx) error {
	return h.serviceTransition(c, "completed", "completed_at")
}

type skipServiceRequest struct {
	Reason string `json:"reason" validate:"omitempty,max=200"`
}

func (h *JobsHandler) ServiceSkip(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	serviceID := c.Params("service_id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	var req skipServiceRequest
	_ = c.BodyParser(&req)
	if err := h.service.MarkBookingServiceSkipped(c.UserContext(), bookingID, serviceID, helperID, req.Reason); err != nil {
		if errors.Is(err, ErrServiceNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to skip"})
	}
	return c.JSON(fiber.Map{"message": "skipped"})
}

func (h *JobsHandler) serviceTransition(c *fiber.Ctx, status, stampField string) error {
	bookingID := c.Params("id")
	serviceID := c.Params("service_id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	if err := h.service.UpdateBookingServiceStatus(c.UserContext(), bookingID, serviceID, helperID, status, stampField); err != nil {
		if errors.Is(err, ErrServiceNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update service"})
	}
	return c.JSON(fiber.Map{"message": status})
}

func mapAcceptError(c *fiber.Ctx, err error) error {
	status := fiber.StatusInternalServerError
	message := "failed to accept"
	switch {
	case errors.Is(err, ErrAlreadyAccepted), errors.Is(err, ErrBookingNotPending):
		status, message = fiber.StatusConflict, "booking already accepted by another helper"
	case errors.Is(err, ErrTooFarAway):
		status, message = fiber.StatusBadRequest, "too far from booking location"
	case err != nil && err.Error() == "booking not found":
		status, message = fiber.StatusNotFound, "booking not found"
	}
	return c.Status(status).JSON(fiber.Map{"error": message})
}

// ─── Service methods backing the handlers ───────────────────────────

// MarkEnRoute stamps en_route_at on the booking if the requesting pro
// is assigned and the booking is still in 'accepted' state. Fires a
// customer FCM push (best-effort) so the customer sees the pro is
// moving without waiting for the next poll.
func (s *Service) MarkEnRoute(ctx context.Context, bookingID, helperID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	var customerID string
	if err := s.db.QueryRow(queryCtx,
		`UPDATE bookings
		    SET en_route_at = NOW(), updated_at = NOW()
		  WHERE id = $1 AND helper_id = $2 AND status = 'accepted'
		  RETURNING customer_id::text`,
		bookingID, helperID,
	).Scan(&customerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrJobNotInState
		}
		return fmt.Errorf("mark en-route: %w", err)
	}

	// Customer push — best-effort. Failure shouldn't block the pro.
	if s.notifications != nil {
		_ = s.notifications.SendData(ctx, customerID, map[string]string{
			"type":       "pro_en_route",
			"booking_id": bookingID,
		})
	}
	return nil
}

// MarkArrivedGated wraps the existing MarkArrived with a GPS check.
// The pro must be within ArrivedRadiusMeters of the booking address.
// Fires a customer push on success.
func (s *Service) MarkArrivedGated(ctx context.Context, bookingID, helperID string, lat, lng float64) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	var (
		bookingLat float64
		bookingLng float64
		customerID string
	)
	if err := s.db.QueryRow(queryCtx,
		`SELECT lat::float8, lng::float8, customer_id::text
		   FROM bookings
		  WHERE id = $1 AND helper_id = $2 AND status = 'accepted'`,
		bookingID, helperID,
	).Scan(&bookingLat, &bookingLng, &customerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrJobNotInState
		}
		return fmt.Errorf("arrived lookup: %w", err)
	}

	if haversineMeters(lat, lng, bookingLat, bookingLng) > ArrivedRadiusMeters {
		return ErrOutsideArrivedRadius
	}

	if _, err := s.repo.MarkArrived(ctx, bookingID, helperID); err != nil {
		return err
	}

	if s.notifications != nil {
		_ = s.notifications.SendData(ctx, customerID, map[string]string{
			"type":       "pro_arrived",
			"booking_id": bookingID,
		})
	}
	return nil
}

// UpdateBookingServiceStatus flips the per-line status. Guarded so
// only the assigned pro can touch their own job's services.
func (s *Service) UpdateBookingServiceStatus(ctx context.Context, bookingID, serviceLineID, helperID, status, stampField string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	// Format the timestamp column name into the SQL — `stampField` is
	// caller-controlled (set by Go code, never from a user payload),
	// but we still whitelist it to keep the surface narrow.
	var stampCol string
	switch stampField {
	case "started_at":
		stampCol = "started_at"
	case "completed_at":
		stampCol = "completed_at"
	default:
		return fmt.Errorf("invalid stamp field: %s", stampField)
	}

	res, err := s.db.Exec(queryCtx, fmt.Sprintf(`
		UPDATE booking_services
		   SET status = $3,
		       %s    = COALESCE(%s, now())
		 WHERE id = $1 AND booking_id = $2
		   AND EXISTS (
		       SELECT 1 FROM bookings b
		        WHERE b.id = $2 AND b.helper_id = $4 AND b.status IN ('accepted','arrived','in_progress')
		   )
	`, stampCol, stampCol),
		serviceLineID, bookingID, status, helperID)
	if err != nil {
		return fmt.Errorf("update booking_service: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrServiceNotFound
	}
	return nil
}

// MarkBookingServiceSkipped is the same as the above but writes
// skip_reason and forces status='skipped'.
func (s *Service) MarkBookingServiceSkipped(ctx context.Context, bookingID, serviceLineID, helperID, reason string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	res, err := s.db.Exec(queryCtx, `
		UPDATE booking_services
		   SET status      = 'skipped',
		       completed_at = COALESCE(completed_at, now()),
		       skip_reason  = NULLIF($5, '')
		 WHERE id = $1 AND booking_id = $2
		   AND EXISTS (
		       SELECT 1 FROM bookings b
		        WHERE b.id = $2 AND b.helper_id = $4 AND b.status IN ('accepted','arrived','in_progress')
		   )
	`, serviceLineID, bookingID, "skipped", helperID, reason)
	if err != nil {
		return fmt.Errorf("skip booking_service: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrServiceNotFound
	}
	return nil
}

// RevealCustomerContact returns the assigned customer's unmasked phone +
// name for the pro to dial. Inserts a pro_contact_reveals audit row on
// every successful call.
//
// Returns ErrContactForbidden when the booking is not assigned to this
// pro, ErrContactInvalidState when the booking is outside the allowed
// state set (pending / completed / cancelled / etc.).
func (s *Service) RevealCustomerContact(ctx context.Context, bookingID, helperID, userAgent string) (*ContactResponse, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// One round-trip: pull helper_id + status + customer columns. If the
	// booking doesn't exist we return Forbidden too (intentionally vague
	// to avoid leaking booking existence to a non-owner pro).
	var (
		dbHelperID    *string
		dbStatus      string
		customerPhone string
		customerName  string
	)
	err := s.db.QueryRow(queryCtx, `
		SELECT b.helper_id::text, b.status, COALESCE(u.phone,''), COALESCE(u.name,'')
		FROM bookings b
		JOIN users u ON u.id = b.customer_id
		WHERE b.id = $1
	`, bookingID).Scan(&dbHelperID, &dbStatus, &customerPhone, &customerName)
	if err != nil {
		// pgx.ErrNoRows or any read error → treat as forbidden so the
		// response shape stays uniform and information disclosure is
		// minimised.
		return nil, ErrContactForbidden
	}
	if dbHelperID == nil || *dbHelperID != helperID {
		return nil, ErrContactForbidden
	}

	switch dbStatus {
	case string(StatusAccepted), "arrived", string(StatusInProgress):
		// allowed
	default:
		return nil, ErrContactInvalidState
	}

	// Audit-or-bust: migration 102's header mandates a pro_contact_reveals
	// row before any unmasked-phone disclosure (privacy review). Wrap the
	// audit INSERT + the customer phone read in one transaction. If the
	// audit write fails we ROLLBACK and return ErrContactAuditFailed with
	// NO PII — never reveal a number without a guaranteed audit record.
	tx, terr := s.db.Begin(queryCtx)
	if terr != nil {
		log.Error().Err(terr).Str("booking_id", bookingID).Str("pro_id", helperID).Msg("[jobs] contact reveal: begin tx failed")
		return nil, ErrContactAuditFailed
	}
	defer tx.Rollback(queryCtx) // no-op after a successful Commit

	if _, aerr := tx.Exec(queryCtx, `
		INSERT INTO pro_contact_reveals (booking_id, pro_id, pro_user_agent)
		VALUES ($1::uuid, $2::uuid, NULLIF($3, ''))
	`, bookingID, helperID, userAgent); aerr != nil {
		log.Error().Err(aerr).Str("booking_id", bookingID).Str("pro_id", helperID).Msg("[jobs] contact reveal audit insert failed")
		return nil, ErrContactAuditFailed
	}

	// Read the phone within the same tx so the disclosed number is
	// consistent with the audited reveal.
	if rerr := tx.QueryRow(queryCtx, `
		SELECT COALESCE(u.phone,''), COALESCE(u.name,'')
		FROM bookings b JOIN users u ON u.id = b.customer_id
		WHERE b.id = $1
	`, bookingID).Scan(&customerPhone, &customerName); rerr != nil {
		log.Error().Err(rerr).Str("booking_id", bookingID).Str("pro_id", helperID).Msg("[jobs] contact reveal: phone read in tx failed")
		return nil, ErrContactAuditFailed
	}

	if cerr := tx.Commit(queryCtx); cerr != nil {
		log.Error().Err(cerr).Str("booking_id", bookingID).Str("pro_id", helperID).Msg("[jobs] contact reveal: commit failed")
		return nil, ErrContactAuditFailed
	}

	// Strip +91 / 91 country code if present; the pro app pipes the value
	// straight to tel: and the dialer doesn't care, but the spec asked for
	// a 10-digit national number with no prefix.
	digits := make([]byte, 0, len(customerPhone))
	for i := 0; i < len(customerPhone); i++ {
		if customerPhone[i] >= '0' && customerPhone[i] <= '9' {
			digits = append(digits, customerPhone[i])
		}
	}
	if len(digits) == 12 && digits[0] == '9' && digits[1] == '1' {
		digits = digits[2:]
	}

	return &ContactResponse{
		CustomerPhone: string(digits),
		CustomerName:  customerName,
	}, nil
}

func haversineMeters(lat1, lng1, lat2, lng2 float64) float64 {
	const earthMetres = 6_371_000.0
	rad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat := rad(lat2 - lat1)
	dLng := rad(lng2 - lng1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(rad(lat1))*math.Cos(rad(lat2))*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthMetres * math.Asin(math.Sqrt(a))
}
