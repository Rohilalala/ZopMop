package insights

import (
	"math"
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// roundCoord rounds a latitude/longitude to 2 decimals (~1.1km) for safe logging.
func roundCoord(x float64) float64 { return math.Round(x*100) / 100 }

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
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid coordinates"})
	}

	stats, err := h.service.NearbyStats(c.Context(), lat, lon)
	if err != nil {
		log.Error().Err(err).
			Float64("lat", roundCoord(lat)).
			Float64("lon", roundCoord(lon)).
			Msg("nearby insights failed; returning empty")
		return c.JSON(&NearbyStats{NearbyCount: 0, AvgRating: 0, AvgEtaMin: 0})
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
		log.Error().Err(err).Str("user_id", userID).Msg("my usuals failed; returning empty")
		return c.JSON(fiber.Map{"service_ids": []string{}})
	}
	if ids == nil {
		ids = []string{}
	}
	return c.JSON(fiber.Map{"service_ids": ids})
}
