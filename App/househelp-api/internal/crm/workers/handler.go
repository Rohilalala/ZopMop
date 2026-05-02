package workers

import (
	"errors"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

// Handler is the HTTP layer for the workers module.
type Handler struct {
	repo     *Repository
	recorder *audit.Recorder
}

// NewHandler constructs a Handler.
func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// RegisterRoutes mounts /workers/* on the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/workers")
	g.Get("/",                   h.List)
	g.Get("/live",               h.LivePins)
	g.Get("/:id",                h.Get)
	g.Get("/:id/jobs",           h.Jobs)
	g.Get("/:id/active-job",     h.ActiveJob)
	g.Post("/:id/approve",       h.Approve)
	g.Post("/:id/reject",        h.Reject)
	g.Post("/:id/suspend",       h.Suspend)
	g.Post("/:id/unsuspend",     h.Unsuspend)
	g.Post("/:id/force-offline", h.ForceOffline)
	g.Put("/:id/categories",     h.SetCategories)
}

// List handles GET /workers.
func (h *Handler) List(c *fiber.Ctx) error {
	f := parseListFilter(c)
	out, err := h.repo.List(c.Context(), f)
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
}

// Get handles GET /workers/:id.
func (h *Handler) Get(c *fiber.Ctx) error {
	d, err := h.repo.Get(c.Context(), c.Params("id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		log.Error().Err(err).Msg("[crm.workers] get failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(d)
}

// Jobs handles GET /workers/:id/jobs.
func (h *Handler) Jobs(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	out, err := h.repo.Jobs(c.Context(), c.Params("id"), limit)
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] jobs failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"jobs": out})
}

// ActiveJob handles GET /workers/:id/active-job.
func (h *Handler) ActiveJob(c *fiber.Ctx) error {
	has, id, err := h.repo.HasActiveJob(c.Context(), c.Params("id"))
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] active job failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"has_active": has, "booking_id": id})
}

// LivePins handles GET /workers/live.
func (h *Handler) LivePins(c *fiber.Ctx) error {
	out, err := h.repo.LivePins(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] live pins failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"pins": out})
}

// Approve handles POST /workers/:id/approve.
func (h *Handler) Approve(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.Approve(c.Context(), id); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.approve", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

// Reject handles POST /workers/:id/reject.
func (h *Handler) Reject(c *fiber.Ctx) error {
	var req RejectRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	if err := h.repo.Reject(c.Context(), id); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.reject", id, nil, req.Reason)
	return c.JSON(fiber.Map{"ok": true})
}

// Suspend handles POST /workers/:id/suspend.
func (h *Handler) Suspend(c *fiber.Ctx) error {
	var req SuspendRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	if err := h.repo.Suspend(c.Context(), id, req.Reason); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.suspend", id, nil, req.Reason)
	return c.JSON(fiber.Map{"ok": true})
}

// Unsuspend handles POST /workers/:id/unsuspend.
func (h *Handler) Unsuspend(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.Unsuspend(c.Context(), id); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.unsuspend", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

// ForceOffline handles POST /workers/:id/force-offline.
func (h *Handler) ForceOffline(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.ForceOffline(c.Context(), id); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.force_offline", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

// SetCategories handles PUT /workers/:id/categories.
func (h *Handler) SetCategories(c *fiber.Ctx) error {
	var req SetCategoriesRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	id := c.Params("id")
	if err := h.repo.SetCategories(c.Context(), id, req.Categories); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.categories.set", id, nil, req.Categories)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) errResp(c *fiber.Ctx, err error) error {
	if errors.Is(err, ErrNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
	}
	log.Error().Err(err).Msg("[crm.workers] action failed")
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
		Module:     "workers",
		TargetType: "worker",
		TargetID:   targetID,
		Before:     before,
		After:      after,
		IPAddress:  c.IP(),
		UserAgent:  c.Get("User-Agent"),
		RequestID:  c.Get("X-Request-ID"),
	})
}

func parseListFilter(c *fiber.Ctx) ListFilter {
	q := func(k string) string { return strings.TrimSpace(c.Query(k)) }
	intQ := func(k string, dflt int) int {
		v, err := strconv.Atoi(q(k))
		if err != nil {
			return dflt
		}
		return v
	}
	return ListFilter{
		Search:     q("search"),
		Status:     Status(q("status")),
		Category:   q("category"),
		OnlyOnline: q("only_online") == "true" || q("only_online") == "1",
		SortBy:     q("sort_by"),
		SortDir:    q("sort_dir"),
		Limit:      intQ("limit", 50),
		Offset:     intQ("offset", 0),
	}
}
