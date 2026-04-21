package helper

import (
	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the helper module.
type Handler struct {
	service *Service
}

// NewHandler creates a new helper handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts helper routes (all require JWT auth + pro role).
// Customer JWTs must not reach helper workflows (location broadcasts,
// invite queues, online/offline toggle).
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Use(middleware.RequireRole("pro"))
	router.Get("/me/profile", h.GetProfile)
	router.Get("/me/invites", h.GetInvites)
	router.Post("/me/invites/:bookingId/decline", h.DeclineInvite)
	router.Put("/me/location", h.UpdateLocation)
	router.Put("/me/status", h.SetStatus)
}

// GetProfile handles GET /helpers/me/profile.
func (h *Handler) GetProfile(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	profile, err := h.service.GetProfile(c.Context(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get helper profile")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "profile not found"})
	}
	return c.JSON(profile)
}

// GetInvites handles GET /helpers/me/invites.
// Returns all pending booking invites the matching engine has assigned to this helper.
func (h *Handler) GetInvites(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	invites, err := h.service.GetInvites(c.Context(), helperID)
	if err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to get invites")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch invites"})
	}
	return c.JSON(fiber.Map{"invites": invites})
}

// DeclineInvite handles POST /helpers/me/invites/:bookingId/decline.
func (h *Handler) DeclineInvite(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	bookingID := c.Params("bookingId")
	if !validator.IsUUID(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	if err := h.service.DeclineInvite(c.Context(), helperID, bookingID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to decline invite"})
	}
	return c.JSON(fiber.Map{"message": "invite declined"})
}

// UpdateLocation handles PUT /helpers/me/location.
// Called by the pro app on a timer to keep the matching engine's view fresh.
func (h *Handler) UpdateLocation(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	var req LocationUpdateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if req.Lat < -90 || req.Lat > 90 || req.Lng < -180 || req.Lng > 180 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid coordinates"})
	}
	if err := h.service.UpdateLocation(c.Context(), helperID, req.Lat, req.Lng); err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to update location")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update location"})
	}
	return c.JSON(fiber.Map{"status": "ok"})
}

// SetStatus handles PUT /helpers/me/status.
// Allows a helper to go online (is_available=true) or offline (false).
func (h *Handler) SetStatus(c *fiber.Ctx) error {
	helperID, _ := c.Locals("userID").(string)
	var req StatusUpdateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := h.service.SetAvailability(c.Context(), helperID, req.IsAvailable); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update status"})
	}
	return c.JSON(fiber.Map{"is_available": req.IsAvailable})
}
