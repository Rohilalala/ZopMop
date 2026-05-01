package zones

import (
	"math"
	"strconv"

	"github.com/adityarohilla/househelp-api/internal/admin"
	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// roundCoord rounds a lat/lon to 2 decimals (~1.1 km) for safe logging.
func roundCoord(x float64) float64 { return math.Round(x*100) / 100 }

// Handler handles HTTP requests for the zones module.
type Handler struct {
	service *ZoneService
}

func NewHandler(service *ZoneService) *Handler {
	return &Handler{service: service}
}

// RegisterPublicRoutes mounts public zone routes.
func (h *Handler) RegisterPublicRoutes(router fiber.Router) {
	router.Get("/check", h.Check)
}

// RegisterAdminRoutes mounts admin-only zone routes. Listing service zones
// reveals operational geography, so it is gated on the `manage_config`
// permission rather than the generic admin role.
func (h *Handler) RegisterAdminRoutes(router fiber.Router) {
	router.Get("/", middleware.RequirePermission(admin.PermManageConfig), h.ListZones)
}

// Check handles GET /zones/check?lat=X&lon=Y
func (h *Handler) Check(c *fiber.Ctx) error {
	latStr := c.Query("lat")
	lonStr := c.Query("lon")

	if latStr == "" || lonStr == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "lat and lon query params are required",
		})
	}

	lat, err := strconv.ParseFloat(latStr, 64)
	if err != nil || lat < -90 || lat > 90 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid lat"})
	}
	lon, err := strconv.ParseFloat(lonStr, 64)
	if err != nil || lon < -180 || lon > 180 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid lon"})
	}

	result, err := h.service.Check(c.Context(), lat, lon)
	if err != nil {
		log.Error().Err(err).Float64("lat", roundCoord(lat)).Float64("lon", roundCoord(lon)).Msg("zone check failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "zone check failed"})
	}
	return c.JSON(result)
}

// ListZones handles GET /admin/zones
func (h *Handler) ListZones(c *fiber.Ctx) error {
	zones, err := h.service.ListZones(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to list zones")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to list zones"})
	}
	return c.JSON(zones)
}
