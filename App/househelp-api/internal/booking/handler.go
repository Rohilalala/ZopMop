package booking

import (
	"errors"
	"strconv"
	"strings"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
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
func (h *Handler) RegisterRoutes(router fiber.Router, idem fiber.Handler) {
	proOnly := middleware.RequireRole("pro")

	if idem != nil {
		router.Post("/", idem, h.CreateBooking)
		router.Post("/scheduled", idem, h.CreateScheduledBooking)
	} else {
		router.Post("/", h.CreateBooking)
		router.Post("/scheduled", h.CreateScheduledBooking)
	}
	router.Get("/helper/invites", proOnly, h.GetHelperInvites)
	router.Get("/", h.GetBookings)
	router.Get("/:id/match-status", h.GetMatchStatus)
	router.Get("/:id/tracking", h.GetTracking)
	router.Get("/:id", h.GetBooking)
	router.Post("/:id/cancel", h.CancelBooking)
	router.Post("/:id/accept", proOnly, h.AcceptBooking)
	router.Post("/:id/start", proOnly, h.StartBooking)
	router.Post("/:id/complete", proOnly, h.CompleteBooking)
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

	booking, err := h.service.CreateBooking(c.Context(), &req, customerID)
	if err != nil {
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

// GetBooking handles GET /bookings/:id.
func (h *Handler) GetBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	booking, err := h.service.GetBooking(c.Context(), bookingID, userID)
	if err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Msg("failed to get booking")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "booking not found",
		})
	}

	return c.JSON(booking)
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
		bookings, err := h.service.repo.GetCustomerBookingsByStatus(c.Context(), userID, status, page, limit)
		if err != nil {
			log.Error().Err(err).Str("user_id", userID).Msg("failed to get bookings by status")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load bookings"})
		}
		return c.JSON(fiber.Map{"bookings": bookings})
	}

	// Legacy path: return all bookings without service details.
	bookings, err := h.service.repo.GetCustomerBookings(c.Context(), userID, page, limit)
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
	items, err := h.service.GetCartItemsForUser(c.Context(), userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to fetch cart items")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to read cart"})
	}
	if len(items) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cart is empty"})
	}

	// Resolve time slot to a scheduled timestamp.
	scheduledTime, err := h.service.GetSlotScheduledTime(c.Context(), req.TimeSlotID)
	if err != nil {
		if err.Error() == "time slot not found or unavailable" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "time slot not found or unavailable"})
		}
		log.Error().Err(err).Str("slot_id", req.TimeSlotID).Msg("failed to resolve slot schedule")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to resolve slot schedule"})
	}

	booking, err := h.service.CreateScheduledBooking(c.Context(), userID, &req, items, scheduledTime)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to create scheduled booking")
		if errors.Is(err, ErrAddressNotOwned) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "address does not belong to caller"})
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
	h.service.ClearUserCart(c.Context(), userID)

	return c.Status(fiber.StatusCreated).JSON(booking)
}

// CancelBooking handles POST /bookings/:id/cancel.
func (h *Handler) CancelBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	if err := h.service.CancelBooking(c.Context(), bookingID, userID); err != nil {
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

	return c.JSON(fiber.Map{"message": "booking cancelled"})
}

// AcceptBooking handles POST /bookings/:id/accept (helper accepts a booking).
func (h *Handler) AcceptBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)

	if err := h.service.AcceptBooking(c.Context(), bookingID, helperID); err != nil {
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

	resp, err := h.service.GetMatchStatus(c.Context(), bookingID, userID)
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

	bookingIDs, err := h.service.GetHelperInvites(c.Context(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get helper invites")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to get invites"})
	}

	return c.JSON(fiber.Map{"booking_ids": bookingIDs})
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

	resp, err := h.service.GetTracking(c.Context(), bookingID, userID)
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
func (h *Handler) StartBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	helperID, _ := c.Locals("userID").(string)

	if err := h.service.StartBooking(c.Context(), bookingID, helperID); err != nil {
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

	if err := h.service.CompleteBooking(c.Context(), bookingID, helperID); err != nil {
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
