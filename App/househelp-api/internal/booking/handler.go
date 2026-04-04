package booking

import (
	"strconv"

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

// RegisterRoutes mounts booking routes onto the given router group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/", h.CreateBooking)
	router.Post("/scheduled", h.CreateScheduledBooking)
	router.Get("/", h.GetBookings)
	router.Get("/:id", h.GetBooking)
	router.Post("/:id/cancel", h.CancelBooking)
	router.Post("/:id/accept", h.AcceptBooking)
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
		if err.Error() == "service category not found" {
			status = fiber.StatusNotFound
		} else if err.Error() == "maximum active bookings limit reached" || err.Error() == "service category is not available" {
			status = fiber.StatusBadRequest
		}

		return c.Status(status).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	return c.Status(fiber.StatusCreated).JSON(booking)
}

// GetBooking handles GET /bookings/:id.
func (h *Handler) GetBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
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
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	booking, err := h.service.CreateScheduledBooking(c.Context(), userID, &req, items, scheduledTime)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to create scheduled booking")
		status := fiber.StatusInternalServerError
		if err.Error() == "cart is empty" {
			status = fiber.StatusBadRequest
		}
		return c.Status(status).JSON(fiber.Map{"error": err.Error()})
	}

	// Clear cart on success (best-effort, don't fail the response).
	h.service.ClearUserCart(c.Context(), userID)

	return c.Status(fiber.StatusCreated).JSON(booking)
}

// CancelBooking handles POST /bookings/:id/cancel.
func (h *Handler) CancelBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	userID, _ := c.Locals("userID").(string)

	if err := h.service.CancelBooking(c.Context(), bookingID, userID); err != nil {
		log.Error().Err(err).
			Str("booking_id", bookingID).
			Str("user_id", userID).
			Msg("failed to cancel booking")

		status := fiber.StatusInternalServerError
		if err.Error() == "booking not found" {
			status = fiber.StatusNotFound
		} else if err.Error() == "booking cannot be cancelled in current status" {
			status = fiber.StatusBadRequest
		}

		return c.Status(status).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	return c.JSON(fiber.Map{"message": "booking cancelled"})
}

// AcceptBooking handles POST /bookings/:id/accept (helper accepts a booking).
func (h *Handler) AcceptBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	helperID, _ := c.Locals("userID").(string)

	if err := h.service.AcceptBooking(c.Context(), bookingID, helperID); err != nil {
		log.Error().Err(err).
			Str("booking_id", bookingID).
			Str("helper_id", helperID).
			Msg("failed to accept booking")

		status := fiber.StatusInternalServerError
		if err.Error() == "booking not found" || err.Error() == "booking not found or not in pending status" {
			status = fiber.StatusNotFound
		} else if err.Error() == "booking is not in pending status" ||
			err.Error() == "helper already has maximum active bookings" {
			status = fiber.StatusBadRequest
		}

		return c.Status(status).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	return c.JSON(fiber.Map{"message": "booking accepted"})
}
