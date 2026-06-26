package shiftsessions

import (
	"errors"
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	r.Get("/shift-sessions/:id/selfies", middleware.RequirePermission("shift_sessions.read"), h.Selfies)
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

// Selfies handles GET /admin/shift-sessions/:id/selfies — lazy-loads the
// (large, base64) selfie images for one session so the list response stays small.
func (h *Handler) Selfies(c *fiber.Ctx) error {
	id := c.Params("id")
	if _, err := uuid.Parse(id); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid session id"})
	}
	out, err := h.repo.GetSelfies(c.UserContext(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "session not found"})
		}
		log.Error().Err(err).Str("id", id).Msg("[crm.shift-sessions] selfies failed")
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
