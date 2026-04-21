package places

import (
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	"github.com/gofiber/fiber/v2"
)

// Handler serves the Places autocomplete proxy.
type Handler struct {
	maps *googlemaps.Client
}

// NewHandler creates a places handler. maps may be nil (key not configured).
func NewHandler(maps *googlemaps.Client) *Handler {
	return &Handler{maps: maps}
}

// RegisterRoutes mounts the places routes onto the given router group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Get("/autocomplete", h.Autocomplete)
}

// Autocomplete handles GET /places/autocomplete?q=...
func (h *Handler) Autocomplete(c *fiber.Ctx) error {
	q := c.Query("q")
	if q == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "q is required"})
	}
	if h.maps == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "maps service not configured"})
	}

	results, err := h.maps.PlacesAutocomplete(c.Context(), q)
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "places lookup failed"})
	}
	return c.JSON(fiber.Map{"results": results})
}
