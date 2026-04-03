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

// GetBookings handles GET /bookings (list customer's own bookings).
func (h *Handler) GetBookings(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 50 {
		limit = 20
	}

	bookings, err := h.service.repo.GetCustomerBookings(c.Context(), userID, page, limit)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to get bookings")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load bookings",
		})
	}

	if bookings == nil {
		bookings = []Booking{}
	}

	return c.JSON(fiber.Map{"bookings": bookings})
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
		if err.Error() == "booking not found" || err.Error() == "booking not found" {
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
