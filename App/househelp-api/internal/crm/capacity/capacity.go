// Package capacity exposes the booking window-recount model (spec §14.2) as a
// read-only CRM surface: GET /admin/capacity?locality=&date= returns the
// per-slot capacity breakdown {roster, on_leave, committed, free} ops uses to
// see where the force-assigner has headroom. The math lives in internal/booking
// (CapacityForDate); this package is only the HTTP/validation layer.
package capacity

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/booking"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

// Handler is the HTTP layer over booking.Repository.CapacityForDate.
type Handler struct {
	repo *booking.Repository
}

// NewHandler wires a Handler over the CRM db pool. It constructs its own
// booking.Repository so the capacity math stays in the booking package.
func NewHandler(db *pgxpool.Pool) *Handler {
	return &Handler{repo: booking.NewRepository(db)}
}

// RegisterRoutes mounts /capacity under the (already-authed) admin group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Get("/capacity", middleware.RequirePermission("capacity.read"), h.Get)
}

// Get — GET /admin/capacity?locality=&date=. Read-only; returns the day's
// per-slot capacity breakdown for the locality.
func (h *Handler) Get(c *fiber.Ctx) error {
	locality := strings.TrimSpace(c.Query("locality"))
	date := strings.TrimSpace(c.Query("date"))
	if locality == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "locality is required"})
	}
	if _, err := time.Parse("2006-01-02", date); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "date must be YYYY-MM-DD"})
	}

	windows, err := h.repo.CapacityForDate(c.UserContext(), locality, date)
	if err != nil {
		log.Error().Err(err).Str("locality", locality).Str("date", date).Msg("[capacity] read failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load capacity"})
	}
	return c.JSON(fiber.Map{"locality": locality, "date": date, "windows": windows})
}
