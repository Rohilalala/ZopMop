package slots

import (
	"regexp"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// Handler handles HTTP requests for time slots.
type Handler struct {
	service *Service
}

// NewHandler creates a new slots handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts slot routes (requires JWT auth).
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Get("/", h.GetByDate)
}

// GetByDate handles GET /slots?date=YYYY-MM-DD.
func (h *Handler) GetByDate(c *fiber.Ctx) error {
	date := c.Query("date")
	if date == "" || !dateRe.MatchString(date) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "date query param required in format YYYY-MM-DD",
		})
	}

	slotList, err := h.service.GetByDate(c.Context(), date)
	if err != nil {
		log.Error().Err(err).Str("date", date).Msg("failed to get time slots")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch time slots"})
	}
	return c.JSON(fiber.Map{"slots": slotList, "date": date})
}
