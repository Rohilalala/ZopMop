package booking

import (
	"errors"
	"strconv"
	"strings"

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
	router.Get("/helper/invites", append(proChain, h.GetHelperInvites)...)
	router.Get("/helper/active", append(proChain, h.GetHelperActive)...)
	router.Get("/helper/today", append(proChain, h.GetHelperToday)...)
	router.Get("/", h.GetBookings)
	router.Get("/:id/match-status", h.GetMatchStatus)
	router.Get("/:id/tracking", h.GetTracking)
	router.Get("/:id/messages", h.ListMessages)
	router.Post("/:id/messages", h.SendMessage)
	router.Get("/:id", h.GetBooking)
	router.Post("/:id/cancel", h.CancelBooking)
	router.Delete("/:id", h.CancelBooking)
	router.Post("/:id/reschedule", h.RescheduleBooking)
	router.Post("/:id/keep-looking", h.KeepLookingBooking)
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

	booking, err := h.service.CreateBooking(c.UserContext(), &req, customerID)
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

		// Instant booking is closed overnight (20:00–06:00 IST) — return 503
		// with a stable code so the app can show a "we're closed" prompt
		// instead of a generic failure.
		if errors.Is(err, ErrInstantBookingClosed) {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"error": "instant booking is closed overnight — please try after 6am",
				"code":  "INSTANT_BOOKING_CLOSED",
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

		log.Error().Err(err).Str("customer_id", customerID).Msg("failed to create booking")

		status := fiber.StatusInternalServerError
		message := "failed to create booking"
		if err.Error() == "service category not found" {
			status = fiber.StatusNotFound
			message = "service category not found"
		} else if err.Error() == "maximum active bookings limit reached" || err.Error() == "service category is not available" {
			status = fiber.StatusBadRequest
			message = err.Error()
		}

		return c.Status(status).JSON(fiber.Map{
			"error": message,
		})
	}

	return c.Status(fiber.StatusCreated).JSON(booking)
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
		log.Error().Err(err).Str("user_id", userID).Msg("failed to create scheduled booking")
		if errors.Is(err, ErrAddressNotOwned) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "address does not belong to caller"})
		}
		if errors.Is(err, ErrSlotUnavailable) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "this time slot is no longer available — please pick another",
			})
		}
		if errors.Is(err, ErrSlotTooFar) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "Bookings can only be made up to 2 days in advance.",
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
		status := fiber.StatusInternalServerError
		message := "failed to create scheduled booking"
		if err.Error() == "cart is empty" {
			status = fiber.StatusBadRequest
			message = "cart is empty"
		} else if strings.HasPrefix(err.Error(), "invalid promo code: ") {
			status = fiber.StatusBadRequest
			message = "invalid promo code"
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}

	// Clear cart on success (best-effort, don't fail the response).
	h.service.ClearUserCart(c.UserContext(), userID)

	return c.Status(fiber.StatusCreated).JSON(booking)
}

// CancelBooking handles POST /bookings/:id/cancel and DELETE /bookings/:id.
// Response body echoes whether a cancellation fee was charged so the app can
// surface it without a follow-up GET.
// KeepLookingBooking handles POST /bookings/:id/keep-looking. Used when a
// stealth-instant booking has rolled into 'pending_customer_action' (15 min
// of searching with no acceptance) and the customer chooses to extend the
// search window by another 15 minutes instead of cancelling. The
// stealth-dispatch cron picks the booking back up on its next tick once
// fire_at moves into the past.
func (h *Handler) KeepLookingBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)
	if err := h.service.KeepLookingBooking(c.UserContext(), bookingID, userID); err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Str("user_id", userID).Msg("[booking] keep-looking failed")
		switch err.Error() {
		case "booking not found":
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "booking not found"})
		case "booking not in pending_customer_action":
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "booking is not waiting for your decision"})
		case "forbidden":
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "forbidden"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to extend search"})
	}
	return c.JSON(fiber.Map{"ok": true, "status": "searching"})
}

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
		log.Error().Err(err).
			Str("booking_id", bookingID).
			Str("user_id", userID).
			Msg("failed to reschedule booking")

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
		if strings.HasPrefix(err.Error(), "invalid scheduled time") {
			status = fiber.StatusBadRequest
			message = "invalid scheduled time"
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

// startBookingRequest is the POST /bookings/:id/start body. The OTP is the
// 6-digit code the customer reads off TrackLive and the pro types into the
// pro app — see two-OTP payment-gated flow (Phase 1 Step 1).
type startBookingRequest struct {
	OTP string `json:"otp"`
}

// completeBookingRequest is the POST /bookings/:id/complete body. The OTP
// is the end-OTP issued after payment resolves.
type completeBookingRequest struct {
	OTP string `json:"otp"`
}

func (h *Handler) StartBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)
	var req startBookingRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := h.service.StartBooking(c.UserContext(), bookingID, helperID, req.OTP); err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Str("helper_id", helperID).Msg("failed to start booking")
		return mapOTPGateError(c, err, "start")
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
	var req completeBookingRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := h.service.CompleteBooking(c.UserContext(), bookingID, helperID, req.OTP); err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Str("helper_id", helperID).Msg("failed to complete booking")
		return mapOTPGateError(c, err, "complete")
	}

	return c.JSON(fiber.Map{"message": "booking completed"})
}

// mapOTPGateError translates the typed errors returned by StartBooking /
// CompleteBooking into the HTTP shapes the pro app branches on. Codes are
// stable strings so the client can distinguish "wrong code" from "payment
// pending" from "service misconfigured" without parsing prose.
func mapOTPGateError(c *fiber.Ctx, err error, gate string) error {
	switch {
	case errors.Is(err, ErrOTPServiceNotWired):
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"error": "OTP service not available", "code": "OTP_SERVICE_UNAVAILABLE",
		})
	case errors.Is(err, ErrStartOTPRequired), errors.Is(err, ErrEndOTPRequired):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "OTP required", "code": "OTP_REQUIRED",
		})
	case errors.Is(err, ErrInvalidStartOTP), errors.Is(err, ErrInvalidEndOTP):
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"error": "invalid OTP", "code": "OTP_INVALID",
		})
	case errors.Is(err, ErrPaymentNotResolved):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error": "payment not resolved", "code": "PAYMENT_NOT_RESOLVED",
		})
	}
	// Falls through to the legacy "booking not found or cannot be {started,completed}"
	// case, preserved verbatim for existing client error handling.
	wantMsg := "booking not found or cannot be " + gate + "ed"
	if err.Error() == wantMsg {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": wantMsg})
	}
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to " + gate + " booking"})
}
