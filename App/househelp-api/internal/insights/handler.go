package insights

import (
	"strconv"

	"github.com/gofiber/fiber/v2"
)

type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterPublicRoutes mounts /insights/nearby. No auth required — endpoint
// returns coarse aggregate counts/ratings only, never PII.
func (h *Handler) RegisterPublicRoutes(router fiber.Router) {
	router.Get("/nearby", h.Nearby)
}

// RegisterMeRoutes mounts /me/usuals (requires JWT — uses caller's user ID).
func (h *Handler) RegisterMeRoutes(router fiber.Router) {
	router.Get("/usuals", h.MyUsuals)
}

// Nearby handles GET /insights/nearby?lat=&lon=
func (h *Handler) Nearby(c *fiber.Ctx) error {
	latStr := c.Query("lat")
	lonStr := c.Query("lon")
	lat, err := strconv.ParseFloat(latStr, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid lat"})
	}
	lon, err := strconv.ParseFloat(lonStr, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid lon"})
	}

	stats, err := h.service.NearbyStats(c.Context(), lat, lon)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed"})
	}
	return c.JSON(stats)
}

// MyUsuals handles GET /me/usuals — returns service category IDs the
// authenticated user has booked, ranked by recency + frequency.
func (h *Handler) MyUsuals(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
	}

	limit := 6
	if l := c.QueryInt("limit", 0); l > 0 && l <= 20 {
		limit = l
	}

	ids, err := h.service.MyUsuals(c.Context(), userID, limit)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed"})
	}
	if ids == nil {
		ids = []string{}
	}
	return c.JSON(fiber.Map{"service_ids": ids})
}
