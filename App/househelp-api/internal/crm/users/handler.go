package users

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

// Handler is the HTTP layer for the users module.
type Handler struct {
	repo     *Repository
	recorder *audit.Recorder
}

// NewHandler constructs a Handler.
func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// RegisterRoutes mounts /users/* under the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/users")
	g.Get("/",            h.List)
	g.Get("/:id",         h.Get)
	g.Get("/:id/orders",  h.Orders)
	g.Get("/:id/notes",   h.ListNotes)
	g.Post("/:id/notes",  h.AddNote)
	g.Get("/:id/active-orders", h.ActiveOrders)
	g.Post("/:id/suspend",   h.Suspend)
	g.Post("/:id/unsuspend", h.Unsuspend)
	g.Post("/:id/ban",       h.Ban)
	g.Post("/:id/unban",     h.Unban)
	g.Post("/:id/vip",       h.SetVIP)
}

// List handles GET /users.
func (h *Handler) List(c *fiber.Ctx) error {
	f := parseListFilter(c)
	out, err := h.repo.List(c.Context(), f)
	if err != nil {
		log.Error().Err(err).Msg("[crm.users] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
}

// Get handles GET /users/:id.
func (h *Handler) Get(c *fiber.Ctx) error {
	d, err := h.repo.Get(c.Context(), c.Params("id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
		}
		log.Error().Err(err).Msg("[crm.users] get failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(d)
}

// Orders handles GET /users/:id/orders.
func (h *Handler) Orders(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	out, err := h.repo.Orders(c.Context(), c.Params("id"), limit)
	if err != nil {
		log.Error().Err(err).Msg("[crm.users] orders failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"orders": out})
}

// ListNotes handles GET /users/:id/notes.
func (h *Handler) ListNotes(c *fiber.Ctx) error {
	out, err := h.repo.ListNotes(c.Context(), c.Params("id"))
	if err != nil {
		log.Error().Err(err).Msg("[crm.users] list notes failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"notes": out})
}

// AddNote handles POST /users/:id/notes.
func (h *Handler) AddNote(c *fiber.Ctx) error {
	var req AddNoteRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if strings.TrimSpace(req.Body) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "body required"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	n, err := h.repo.AddNote(c.Context(), c.Params("id"), adminID, adminEmail, req.Body)
	if err != nil {
		log.Error().Err(err).Msg("[crm.users] add note failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	h.audit(c, "user.note.add", c.Params("id"), nil, req.Body)
	return c.JSON(n)
}

// ActiveOrders handles GET /users/:id/active-orders. Used by the SPA before
// suspend/ban so the confirmation modal can show "user has N active orders".
func (h *Handler) ActiveOrders(c *fiber.Ctx) error {
	has, count, err := h.repo.HasActiveOrders(c.Context(), c.Params("id"))
	if err != nil {
		log.Error().Err(err).Msg("[crm.users] active orders failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"has_active": has, "count": count})
}

// Suspend handles POST /users/:id/suspend.
func (h *Handler) Suspend(c *fiber.Ctx) error {
	var req SuspendRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	if err := h.repo.Suspend(c.Context(), id, req.Reason); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "user.suspend", id, nil, req.Reason)
	return c.JSON(fiber.Map{"ok": true})
}

// Unsuspend handles POST /users/:id/unsuspend.
func (h *Handler) Unsuspend(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.Unsuspend(c.Context(), id); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "user.unsuspend", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

// Ban handles POST /users/:id/ban.
func (h *Handler) Ban(c *fiber.Ctx) error {
	var req BanRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	if err := h.repo.Ban(c.Context(), id, req.Reason); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "user.ban", id, nil, req.Reason)
	return c.JSON(fiber.Map{"ok": true})
}

// Unban handles POST /users/:id/unban.
func (h *Handler) Unban(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.Unban(c.Context(), id); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "user.unban", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

// SetVIP handles POST /users/:id/vip.
func (h *Handler) SetVIP(c *fiber.Ctx) error {
	var req VIPRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	id := c.Params("id")
	if err := h.repo.SetVIP(c.Context(), id, req.IsVIP); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "user.vip.set", id, nil, req.IsVIP)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) errResp(c *fiber.Ctx, err error) error {
	if errors.Is(err, ErrNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
	}
	log.Error().Err(err).Msg("[crm.users] action failed")
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
}

func (h *Handler) audit(c *fiber.Ctx, action, targetID string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.Context(), audit.Entry{
		AdminID:    adminID,
		AdminEmail: adminEmail,
		Action:     action,
		Module:     "users",
		TargetType: "user",
		TargetID:   targetID,
		Before:     before,
		After:      after,
		IPAddress:  c.IP(),
		UserAgent:  c.Get("User-Agent"),
		RequestID:  c.Get("X-Request-ID"),
	})
}

// parseListFilter pulls query-string filters into a typed ListFilter.
func parseListFilter(c *fiber.Ctx) ListFilter {
	q := func(k string) string { return strings.TrimSpace(c.Query(k)) }
	intQ := func(k string, dflt int) int {
		v, err := strconv.Atoi(q(k))
		if err != nil {
			return dflt
		}
		return v
	}
	int64Q := func(k string, dflt int64) int64 {
		v, err := strconv.ParseInt(q(k), 10, 64)
		if err != nil {
			return dflt
		}
		return v
	}

	f := ListFilter{
		Search:      q("search"),
		Status:      Status(q("status")),
		Role:        q("role"),
		MinOrders:   intQ("min_orders", 0),
		MinLTVCents: int64Q("min_ltv_cents", 0),
		SortBy:      q("sort_by"),
		SortDir:     q("sort_dir"),
		Limit:       intQ("limit", 50),
		Offset:      intQ("offset", 0),
	}

	if vip := q("is_vip"); vip != "" {
		v := vip == "true" || vip == "1"
		f.IsVIP = &v
	}
	if d := q("joined_after"); d != "" {
		if t, err := time.Parse(time.RFC3339, d); err == nil {
			f.JoinedAfter = &t
		}
	}
	if d := q("joined_before"); d != "" {
		if t, err := time.Parse(time.RFC3339, d); err == nil {
			f.JoinedBefore = &t
		}
	}
	return f
}
