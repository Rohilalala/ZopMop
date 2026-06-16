package booking

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the booking module.
type Handler struct {
	service *Service
}

// NewHandler creates a new booking handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

func validateBookingIDParam(bookingID string) bool {
	return validator.IsUUID(bookingID)
}

// RegisterRoutes mounts booking routes onto the given router group.
// Helper-side endpoints (accept, start, complete, invites) are gated by
// RequireRole("pro") to block customer JWTs from self-assigning as helpers.
// idem (optional, may be nil) is an idempotency middleware applied only to
// the booking-creation POST routes to make retries safe.
// createLimiter (optional, may be nil) is a per-user rate limiter applied
// only to the booking-creation POST routes; tighter than the group-wide
// authLimiter because each create fans out to matching, notifications,
// and DB writes.
// RegisterRoutes mounts booking routes. proApproved (typically
// helper.RequireApproved(repo)) gates pro-side operational routes
// — accept/arrived/start/complete plus the helper invite/active/today
// reads — so unapproved helpers can't perform pro work even with a
// valid JWT and role='pro'. Audit A1-F3 chunk 15. proApproved may be
// nil in tests / older binaries; nil-callers degrade to RequireRole
// gating only.
func (h *Handler) RegisterRoutes(router fiber.Router, idem fiber.Handler, createLimiter fiber.Handler, proApproved fiber.Handler) {
	proOnly := middleware.RequireRole("pro")
	proChain := []fiber.Handler{proOnly}
	if proApproved != nil {
		proChain = append(proChain, proApproved)
	}

	createChain := []fiber.Handler{}
	if createLimiter != nil {
		createChain = append(createChain, createLimiter)
	}
	if idem != nil {
		createChain = append(createChain, idem)
	}
	router.Post("/", append(createChain, h.CreateBooking)...)
	router.Post("/scheduled", append(createChain, h.CreateScheduledBooking)...)
	router.Post("/instant", append(createChain, h.CreateInstantBooking)...)
	router.Get("/helper/invites", append(proChain, h.GetHelperInvites)...)
	router.Get("/helper/active", append(proChain, h.GetHelperActive)...)
	router.Get("/helper/today", append(proChain, h.GetHelperToday)...)
	router.Get("/", h.GetBookings)
	router.Get("/availability", h.GetSlotAvailability)
	router.Get("/:id/match-status", h.GetMatchStatus)
	router.Get("/:id/tracking", h.GetTracking)
	router.Get("/:id/messages", h.ListMessages)
	router.Post("/:id/messages", h.SendMessage)
	router.Get("/:id", h.GetBooking)
	router.Post("/:id/cancel", h.CancelBooking)
	router.Delete("/:id", h.CancelBooking)
	router.Post("/:id/reschedule", h.RescheduleBooking)
	router.Post("/:id/accept", append(proChain, h.AcceptBooking)...)
	router.Post("/:id/arrived", append(proChain, h.MarkArrived)...)
	router.Post("/:id/start", append(proChain, h.StartBooking)...)
	router.Post("/:id/complete", append(proChain, h.CompleteBooking)...)
}

// CreateBooking handles POST /bookings.
func (h *Handler) CreateBooking(c *fiber.Ctx) error {
	var req CreateBookingRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	// Validate input.
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	customerID, _ := c.Locals("userID").(string)

	result, err := h.service.CreateBooking(c.UserContext(), &req, customerID)
	if err != nil {
		// Map Postgres unique-violation (e.g. bookings_dedup constraint
		// preventing same customer+category within 1 hour) to 409 Conflict
		// with a stable client-facing code so apps can show a useful prompt
		// instead of a generic 500. This is an expected user-side condition
		// (double-tap, retry without idempotency key) — log at WARN so it
		// doesn't pollute the ERR stream alongside real server faults.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			log.Warn().Str("customer_id", customerID).Msg("rejected duplicate pending booking within 2-minute window")
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "you already have a pending booking for this service — give it a moment to match",
				"code":  "DUPLICATE_BOOKING",
			})
		}

		// No pro free right now (ASAP) — 409 with the earliest regular slot so
		// the app can offer "book it instead" in one round-trip. The booking row
		// was already cancelled (no_pros_found) server-side.
		var noProsErr *ErrNoProsAvailable
		if errors.As(err, &noProsErr) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":         "no pros are free right now",
				"code":          "no_pros_available",
				"earliest_slot": noProsErr.Earliest,
			})
		}

		// Wallet payment selected but balance is short — 402 with a stable
		// code so the app can route the user to the topup screen.
		if errors.Is(err, ErrInsufficientWalletBalance) {
			return c.Status(fiber.StatusPaymentRequired).JSON(fiber.Map{
				"error": "insufficient wallet balance",
				"code":  "INSUFFICIENT_WALLET_BALANCE",
			})
		}

		// Customer has completed-but-unpaid Cashfree bookings — 409 with
		// count + total so the app can render a "settle pending payments"
		// prompt and deep-link to the bookings list.
		var unpaidErr *ErrUnpaidBookings
		if errors.As(err, &unpaidErr) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":       "unpaid bookings block this action",
				"code":        "UNPAID_BOOKINGS",
				"count":       unpaidErr.Count,
				"total_paise": unpaidErr.TotalPaise,
			})
		}

		status := fiber.StatusInternalServerError
		message := "failed to create booking"
		if err.Error() == "service category not found" {
			status = fiber.StatusNotFound
			message = "service category not found"
		} else if err.Error() == "maximum active bookings limit reached" || err.Error() == "service category is not available" {
			status = fiber.StatusBadRequest
			message = err.Error()
		} else if strings.HasPrefix(err.Error(), "invalid promo code: ") {
			status = fiber.StatusBadRequest
			message = "invalid promo code"
		}

		// Only genuine server faults (the default 500) reach the ERR stream;
		// expected client-side rejections mapped above stay out of it.
		if status == fiber.StatusInternalServerError {
			log.Error().Err(err).Str("customer_id", customerID).Msg("failed to create booking")
		}

		return c.Status(status).JSON(fiber.Map{
			"error": message,
		})
	}

	return c.Status(fiber.StatusCreated).JSON(result)
}

// GetBooking handles GET /bookings/:id. Returns the enriched BookingDetail
// shape (booking + helper + services). TrackLiveScreen renders entirely
// from this response.
func (h *Handler) GetBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	detail, err := h.service.GetBookingDetail(c.UserContext(), bookingID, userID)
	if err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Msg("failed to get booking")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "booking not found",
		})
	}

	return c.JSON(detail)
}

// GetBookings handles GET /bookings.
// Supports ?status=upcoming|past for the new scheduling flow.
// Falls back to the legacy flat list when no status filter is given.
func (h *Handler) GetBookings(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	status := c.Query("status") // "upcoming", "past", or ""
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 50 {
		limit = 20
	}

	if status == "upcoming" || status == "past" {
		bookings, err := h.service.repo.GetCustomerBookingsByStatus(c.UserContext(), userID, status, page, limit)
		if err != nil {
			log.Error().Err(err).Str("user_id", userID).Msg("failed to get bookings by status")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load bookings"})
		}
		return c.JSON(fiber.Map{"bookings": bookings})
	}

	// Legacy path: return all bookings without service details.
	bookings, err := h.service.repo.GetCustomerBookings(c.UserContext(), userID, page, limit)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to get bookings")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load bookings"})
	}
	if bookings == nil {
		bookings = []Booking{}
	}
	return c.JSON(fiber.Map{"bookings": bookings})
}

// CreateScheduledBooking handles POST /bookings/scheduled.
// Takes address_id + time_slot_id, reads cart items for the user, and creates
// a full booking with booking_services rows. Clears the cart on success.
func (h *Handler) CreateScheduledBooking(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req CreateScheduledBookingRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	// Fetch cart items.
	items, err := h.service.GetCartItemsForUser(c.UserContext(), userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to fetch cart items")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to read cart"})
	}
	if len(items) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cart is empty"})
	}

	// Resolve time slot to a scheduled timestamp.
	scheduledTime, err := h.service.GetSlotScheduledTime(c.UserContext(), req.TimeSlotID)
	if err != nil {
		if err.Error() == "time slot not found or unavailable" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "time slot not found or unavailable"})
		}
		log.Error().Err(err).Str("slot_id", req.TimeSlotID).Msg("failed to resolve slot schedule")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to resolve slot schedule"})
	}

	booking, err := h.service.CreateScheduledBooking(c.UserContext(), userID, &req, items, scheduledTime)
	if err != nil {
		if errors.Is(err, ErrAddressNotOwned) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "address does not belong to caller"})
		}
		if errors.Is(err, ErrSlotUnavailable) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "that slot just filled up — please pick another",
				"code":  "slot_full",
			})
		}
		if errors.Is(err, ErrSlotTooFar) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "Bookings can only be made up to 2 days in advance.",
			})
		}
		if errors.Is(err, ErrSlotTooSoon) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "slots open 45 minutes out — use ASAP for now",
				"code":  "slot_too_soon",
			})
		}
		if errors.Is(err, ErrSlotInPast) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "selected time slot is in the past — please pick another",
			})
		}
		if errors.Is(err, ErrInsufficientWalletBalance) {
			return c.Status(fiber.StatusPaymentRequired).JSON(fiber.Map{
				"error": "insufficient wallet balance",
				"code":  "INSUFFICIENT_WALLET_BALANCE",
			})
		}
		var unpaidErr *ErrUnpaidBookings
		if errors.As(err, &unpaidErr) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":       "unpaid bookings block this action",
				"code":        "UNPAID_BOOKINGS",
				"count":       unpaidErr.Count,
				"total_paise": unpaidErr.TotalPaise,
			})
		}
		// Map Postgres unique-violation (booking-dedup trigger rejecting a
		// second pending same customer+category insert within 2 minutes) to a
		// clean 409 DUPLICATE_BOOKING, mirroring CreateBooking. Log at WARN so
		// it stays out of the ERR stream.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			log.Warn().Str("user_id", userID).Msg("rejected duplicate pending booking within 2-minute window")
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "you already have a pending booking for this service — give it a moment to match",
				"code":  "DUPLICATE_BOOKING",
			})
		}
		status := fiber.StatusInternalServerError
		message := "failed to create scheduled booking"
		if err.Error() == "cart is empty" {
			status = fiber.StatusBadRequest
			message = "cart is empty"
		} else if strings.HasPrefix(err.Error(), "invalid promo code: ") {
			status = fiber.StatusBadRequest
			message = "invalid promo code"
		}

		// Log only genuine server faults; the typed/mapped 4xx rejections above
		// (slot_too_soon, slot_full, cart empty, promo, etc.) are expected and
		// must not pollute the ERR stream.
		if status == fiber.StatusInternalServerError {
			log.Error().Err(err).Str("user_id", userID).Msg("failed to create scheduled booking")
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	// Clear cart on success (best-effort, don't fail the response).
	h.service.ClearUserCart(c.UserContext(), userID)

	return c.Status(fiber.StatusCreated).JSON(booking)
}

// CreateInstantBooking handles POST /bookings/instant.
// ASAP cart booking: reads the user's server-side cart, force-assigns a pro
// synchronously, and returns the arrival promise. Mirrors CreateScheduledBooking's
// auth/body/cart conventions but bypasses slot capacity (spec §3.2, §5). When no
// pro is free right now the just-created row is cancelled server-side and a 409
// {code:"no_pros_available", earliest_slot} is returned so the app can offer the
// earliest regular slot in one round-trip.
func (h *Handler) CreateInstantBooking(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req CreateInstantBookingRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	// Fetch cart items.
	items, err := h.service.GetCartItemsForUser(c.UserContext(), userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to fetch cart items")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to read cart"})
	}
	if len(items) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cart is empty"})
	}

	// timeSlotID/scheduledTime are cosmetic for ASAP — the service overrides the
	// schedule to "now" and bypasses slot capacity (matches the Zop tool call).
	result, err := h.service.CreateInstantBookingFromCart(
		c.UserContext(), userID, req.AddressID, "", "", items, req.PromoCode, req.PaymentSource,
	)
	if err != nil {
		// No pro free right now — 409 with the earliest regular slot. The booking
		// row was already cancelled (no_pros_found) server-side (spec §5.5).
		var noProsErr *ErrNoProsAvailable
		if errors.As(err, &noProsErr) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":         "no pros are free right now",
				"code":          "no_pros_available",
				"earliest_slot": noProsErr.Earliest,
			})
		}
		if errors.Is(err, ErrAddressNotOwned) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "address does not belong to caller"})
		}
		if errors.Is(err, ErrInsufficientWalletBalance) {
			return c.Status(fiber.StatusPaymentRequired).JSON(fiber.Map{
				"error": "insufficient wallet balance",
				"code":  "INSUFFICIENT_WALLET_BALANCE",
			})
		}
		var unpaidErr *ErrUnpaidBookings
		if errors.As(err, &unpaidErr) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":       "unpaid bookings block this action",
				"code":        "UNPAID_BOOKINGS",
				"count":       unpaidErr.Count,
				"total_paise": unpaidErr.TotalPaise,
			})
		}
		// Map Postgres unique-violation (booking-dedup trigger rejecting a
		// second pending same customer+category insert within 2 minutes) to a
		// clean 409 DUPLICATE_BOOKING, mirroring CreateBooking. Hit by rapid
		// double-taps and the concurrent-ASAP race; log at WARN so it stays out
		// of the ERR stream.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			log.Warn().Str("user_id", userID).Msg("rejected duplicate pending booking within 2-minute window")
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "you already have a pending booking for this service — give it a moment to match",
				"code":  "DUPLICATE_BOOKING",
			})
		}
		status := fiber.StatusInternalServerError
		message := "failed to create instant booking"
		if err.Error() == "cart is empty" {
			status = fiber.StatusBadRequest
			message = "cart is empty"
		} else if err.Error() == "maximum active bookings limit reached" {
			status = fiber.StatusBadRequest
			message = err.Error()
		} else if strings.HasPrefix(err.Error(), "invalid promo code: ") {
			status = fiber.StatusBadRequest
			message = "invalid promo code"
		}
		// Only genuine server faults (the default 500) reach the ERR stream;
		// expected client-side rejections mapped above stay out of it.
		if status == fiber.StatusInternalServerError {
			log.Error().Err(err).Str("user_id", userID).Msg("failed to create instant booking")
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	// Clear cart on success (best-effort, don't fail the response).
	h.service.ClearUserCart(c.UserContext(), userID)

	return c.Status(fiber.StatusCreated).JSON(result)
}

// GetSlotAvailability handles GET /bookings/availability?date=&address_id=.
// It returns the day's slots with is_available recomputed from live capacity
// in the address's locality (see Service.GetSlotAvailability). The address_id
// must be a UUID owned by the caller so localities can't be probed via other
// users' addresses.
func (h *Handler) GetSlotAvailability(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	date := c.Query("date")
	if _, err := time.Parse("2006-01-02", date); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "date must be YYYY-MM-DD"})
	}

	addressID := c.Query("address_id")
	if !validator.IsUUID(addressID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "address_id must be a valid uuid"})
	}

	owns, err := h.service.AddressBelongsToUser(c.UserContext(), addressID, userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Str("address_id", addressID).Msg("[booking] availability ownership check failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to check availability"})
	}
	if !owns {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "address does not belong to caller"})
	}

	resp, err := h.service.GetSlotAvailability(c.UserContext(), addressID, date)
	if err != nil {
		log.Error().Err(err).Str("address_id", addressID).Str("date", date).Msg("[booking] failed to compute slot availability")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to compute slot availability"})
	}
	return c.JSON(resp)
}

// CancelBooking handles POST /bookings/:id/cancel and DELETE /bookings/:id.
// Response body echoes whether a cancellation fee was charged so the app can
// surface it without a follow-up GET.
func (h *Handler) CancelBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	resp, err := h.service.CancelBooking(c.UserContext(), bookingID, userID)
	if err != nil {
		log.Error().Err(err).
			Str("booking_id", bookingID).
			Str("user_id", userID).
			Msg("failed to cancel booking")

		status := fiber.StatusInternalServerError
		message := "failed to cancel booking"
		if err.Error() == "booking not found" {
			status = fiber.StatusNotFound
			message = "booking not found"
		} else if err.Error() == "booking cannot be cancelled in current status" {
			status = fiber.StatusBadRequest
			message = "booking cannot be cancelled in current status"
		}

		return c.Status(status).JSON(fiber.Map{
			"error": message,
		})
	}

	return c.JSON(resp)
}

// RescheduleBookingRequest is the body for POST /bookings/:id/reschedule.
type RescheduleBookingRequest struct {
	TimeSlotID    string `json:"time_slot_id" validate:"required,uuid_format"`
	ScheduledTime string `json:"scheduled_time" validate:"required"`
}

// RescheduleBooking handles POST /bookings/:id/reschedule. Moves an active
// booking to a new time slot atomically. Returns 409 if the new slot is full.
func (h *Handler) RescheduleBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}

	var req RescheduleBookingRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	userID, _ := c.Locals("userID").(string)

	resp, err := h.service.RescheduleBooking(c.UserContext(), bookingID, userID, req.TimeSlotID, req.ScheduledTime)
	if err != nil {
		status := fiber.StatusInternalServerError
		message := "failed to reschedule booking"
		switch err.Error() {
		case "booking not found":
			status = fiber.StatusNotFound
			message = "booking not found"
		case "booking cannot be rescheduled in current status":
			status = fiber.StatusBadRequest
			message = err.Error()
		case "requested slot is fully booked":
			status = fiber.StatusConflict
			message = err.Error()
		}
		if errors.Is(err, ErrSlotUnavailable) {
			status = fiber.StatusConflict
			message = "requested slot is fully booked"
		}
		// The reschedule path re-validates the new slot against the same
		// window rules as a fresh booking (validateSlotTime). Those typed
		// sentinels are expected client-side rejections, not server faults —
		// map each to a clean 400, mirroring CreateScheduledBooking.
		if errors.Is(err, ErrSlotInPast) {
			status = fiber.StatusBadRequest
			message = "selected time slot is in the past — please pick another"
		}
		if errors.Is(err, ErrSlotTooSoon) {
			status = fiber.StatusBadRequest
			message = "slots open 45 minutes out — use ASAP for now"
		}
		if errors.Is(err, ErrSlotTooFar) {
			status = fiber.StatusBadRequest
			message = "Bookings can only be made up to 2 days in advance."
		}
		if strings.HasPrefix(err.Error(), "invalid scheduled time") {
			status = fiber.StatusBadRequest
			message = "invalid scheduled time"
		}

		// Log only genuine server faults; mapped 4xx rejections are expected.
		if status == fiber.StatusInternalServerError {
			log.Error().Err(err).
				Str("booking_id", bookingID).
				Str("user_id", userID).
				Msg("failed to reschedule booking")
		}

		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	return c.JSON(resp)
}

// AcceptBooking handles POST /bookings/:id/accept (helper accepts a booking).
func (h *Handler) AcceptBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)

	if err := h.service.AcceptBooking(c.UserContext(), bookingID, helperID); err != nil {
		log.Error().Err(err).
			Str("booking_id", bookingID).
			Str("helper_id", helperID).
			Msg("failed to accept booking")

		status := fiber.StatusInternalServerError
		message := "failed to accept booking"
		if err.Error() == "booking not found" || err.Error() == "booking not found or not in pending status" {
			status = fiber.StatusNotFound
			message = "booking not found"
		} else if err.Error() == "booking is not in pending status" ||
			err.Error() == "helper already has maximum active bookings" {
			status = fiber.StatusBadRequest
			message = err.Error()
		} else if errors.Is(err, ErrTooFarAway) {
			status = fiber.StatusBadRequest
			message = "too far from booking location"
		} else if errors.Is(err, ErrAlreadyAccepted) || errors.Is(err, ErrBookingNotPending) {
			// Race-loss: another helper grabbed the booking first. Surface as
			// 409 Conflict so the helper app can quietly drop the invite
			// instead of treating it as a server-side fault.
			status = fiber.StatusConflict
			message = "booking already accepted by another helper"
		}

		return c.Status(status).JSON(fiber.Map{
			"error": message,
		})
	}

	return c.JSON(fiber.Map{"message": "booking accepted"})
}

// GetMatchStatus handles GET /bookings/:id/match-status.
// Customers poll this to find out if a helper has been matched to their booking.
// Returns { status: "searching" | "matched" | "failed", helper? }
func (h *Handler) GetMatchStatus(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	resp, err := h.service.GetMatchStatus(c.UserContext(), bookingID, userID)
	if err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Msg("failed to get match status")
		status := fiber.StatusInternalServerError
		message := "failed to get match status"
		if err.Error() == "booking not found" {
			status = fiber.StatusNotFound
			message = "booking not found"
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	return c.JSON(resp)
}

// GetHelperInvites handles GET /bookings/helper/invites.
// Pros poll this to see which pending booking IDs they have been invited to accept.
func (h *Handler) GetHelperInvites(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)

	bookingIDs, err := h.service.GetHelperInvites(c.UserContext(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get helper invites")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to get invites"})
	}

	return c.JSON(fiber.Map{"booking_ids": bookingIDs})
}

// GetHelperActive handles GET /bookings/helper/active.
// Returns this helper's currently-active bookings (status accepted or
// in_progress). Used by the pro dashboard to recover the "current job" view
// after an app restart so the pro never loses sight of an in-flight booking.
func (h *Handler) GetHelperActive(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	bookings, err := h.service.repo.GetHelperActiveBookings(c.UserContext(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get helper active bookings")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load active bookings"})
	}
	if bookings == nil {
		bookings = []Booking{}
	}
	return c.JSON(fiber.Map{"bookings": bookings})
}

// GetHelperToday handles GET /bookings/helper/today.
// Returns this helper's bookings for today — active (accepted/in_progress)
// plus those completed or cancelled today.
func (h *Handler) GetHelperToday(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	bookings, err := h.service.repo.GetHelperBookingsToday(c.UserContext(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get helper today bookings")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load today's bookings"})
	}
	if bookings == nil {
		bookings = []Booking{}
	}
	return c.JSON(fiber.Map{"bookings": bookings})
}

// GetTracking handles GET /bookings/:id/tracking.
// Returns the helper's live location, walking ETA and encoded route polyline.
// Both the customer and the assigned helper may call this.
func (h *Handler) GetTracking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	resp, err := h.service.GetTracking(c.UserContext(), bookingID, userID)
	if err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Msg("failed to get tracking")
		status := fiber.StatusInternalServerError
		message := "failed to get tracking"
		if err.Error() == "booking not found" {
			status = fiber.StatusNotFound
			message = "booking not found"
		} else if err.Error() == "no helper assigned to this booking" ||
			strings.HasPrefix(err.Error(), "tracking not available for booking in ") {
			status = fiber.StatusBadRequest
			message = err.Error()
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	return c.JSON(resp)
}

// StartBooking handles POST /bookings/:id/start.
// Called by the helper when they arrive — transitions accepted → in_progress.
// MarkArrived handles POST /bookings/:id/arrived.
// Called by the assigned helper to flag they've reached the customer's door.
// Does NOT transition status — the job is still "accepted" until /start.
func (h *Handler) MarkArrived(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)

	if err := h.service.MarkArrived(c.UserContext(), bookingID, helperID); err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Str("helper_id", helperID).Msg("failed to mark arrived")
		status := fiber.StatusInternalServerError
		message := "failed to mark arrived"
		if err.Error() == "booking not in accepted state for this helper" {
			status = fiber.StatusBadRequest
			message = err.Error()
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	return c.JSON(fiber.Map{"message": "arrival recorded"})
}

func (h *Handler) StartBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)

	if err := h.service.StartBooking(c.UserContext(), bookingID, helperID); err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Str("helper_id", helperID).Msg("failed to start booking")
		status := fiber.StatusInternalServerError
		message := "failed to start booking"
		if err.Error() == "booking not found or cannot be started" {
			status = fiber.StatusBadRequest
			message = "booking not found or cannot be started"
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	return c.JSON(fiber.Map{"message": "booking started"})
}

// CompleteBooking handles POST /bookings/:id/complete.
// Called by the helper when the service is done — transitions in_progress → completed.
func (h *Handler) CompleteBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)

	if err := h.service.CompleteBooking(c.UserContext(), bookingID, helperID); err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Str("helper_id", helperID).Msg("failed to complete booking")
		status := fiber.StatusInternalServerError
		message := "failed to complete booking"
		if err.Error() == "booking not found or cannot be completed" {
			status = fiber.StatusBadRequest
			message = "booking not found or cannot be completed"
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	return c.JSON(fiber.Map{"message": "booking completed"})
}
