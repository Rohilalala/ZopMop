package shiftsessions

import (
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

// Handler serves the read-only shift-sessions admin view.
type Handler struct{ repo *Repository }

// NewHandler constructs a Handler.
func NewHandler(repo *Repository) *Handler { return &Handler{repo: repo} }

// RegisterRoutes mounts GET /admin/shift-sessions on the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Get("/shift-sessions", middleware.RequirePermission("shift_sessions.read"), h.List)
}

// List handles GET /admin/shift-sessions?limit=&offset= — newest sessions
// with their go-online / go-offline selfies.
func (h *Handler) List(c *fiber.Ctx) error {
	limit := intQuery(c, "limit", 50)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := intQuery(c, "offset", 0)
	if offset < 0 {
		offset = 0
	}
	out, err := h.repo.List(c.UserContext(), limit, offset)
	if err != nil {
		log.Error().Err(err).Msg("[crm.shift-sessions] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
}

func intQuery(c *fiber.Ctx, key string, dflt int) int {
	v, err := strconv.Atoi(c.Query(key))
	if err != nil {
		return dflt
	}
	return v
}
