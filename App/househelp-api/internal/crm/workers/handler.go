package workers

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
)

// Handler is the HTTP layer for the workers module.
type Handler struct {
	repo       *Repository
	recorder   *audit.Recorder
	dispatcher *webhooks.Dispatcher
}

// NewHandler constructs a Handler.
func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// SetDispatcher wires the outbound webhook dispatcher.
func (h *Handler) SetDispatcher(d *webhooks.Dispatcher) { h.dispatcher = d }

func (h *Handler) fireWebhook(ctx context.Context, event string, payload any) {
	if h.dispatcher == nil {
		return
	}
	h.dispatcher.Dispatch(ctx, event, payload)
}

// RegisterRoutes mounts /workers/* on the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/workers")
	read := middleware.RequirePermission("workers.read")
	g.Get("/",                   read, h.List)
	g.Get("/live",               read, h.LivePins)
	g.Post("/",                  middleware.RequirePermission("workers.create"), h.Create)
	g.Get("/:id",                read, h.Get)
	g.Get("/:id/jobs",           read, h.Jobs)
	g.Get("/:id/active-job",     read, h.ActiveJob)
	g.Post("/:id/approve",       middleware.RequirePermission("workers.approve"), h.Approve)
	g.Post("/:id/reject",        middleware.RequirePermission("workers.reject"), h.Reject)
	g.Post("/:id/suspend",       middleware.RequirePermission("workers.suspend"), h.Suspend)
	g.Post("/:id/unsuspend",     middleware.RequirePermission("workers.unsuspend"), h.Unsuspend)
	g.Post("/:id/force-offline", middleware.RequirePermission("workers.force_offline"), h.ForceOffline)
	g.Post("/:id/deductions",    middleware.RequirePermission("workers.deduct"), h.AddDeduction)
	g.Get("/:id/deductions",     read, h.ListDeductions)
	g.Put("/:id/categories",     middleware.RequirePermission("workers.set_categories"), h.SetCategories)
	g.Patch("/:id/locality",     middleware.RequirePermission("workers.suspend"), h.SetLocality)
}

// Create handles POST /workers — admin-initiated pro registration.
func (h *Handler) Create(c *fiber.Ctx) error {
	var req CreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	out, err := h.repo.Create(c.UserContext(), req)
	if err != nil {
		if errors.Is(err, ErrPhoneInUse) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "phone already in use"})
		}
		log.Warn().Err(err).Msg("[crm.workers] create failed")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "worker.create", out.ID, nil, fiber.Map{"phone": out.Phone, "name": req.Name})
	return c.Status(fiber.StatusCreated).JSON(out)
}

// AddDeduction handles POST /workers/:id/deductions — manual fortnight
// deduction. Body: {amount_paise, reason, fortnight_start?}.
func (h *Handler) AddDeduction(c *fiber.Ctx) error {
	id := c.Params("id")
	var req DeductionRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if req.AmountPaise <= 0 || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "amount_paise > 0 and reason required"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	row, err := h.repo.AddDeduction(c.UserContext(), id, adminID, req)
	if err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.deduction.add", id, nil, row)
	return c.Status(fiber.StatusCreated).JSON(row)
}

// ListDeductions handles GET /workers/:id/deductions.
func (h *Handler) ListDeductions(c *fiber.Ctx) error {
	id := c.Params("id")
	rows, err := h.repo.ListDeductions(c.UserContext(), id)
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] list deductions failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": rows})
}

// setLocalityRequest is the input body for SetLocality. Empty/whitespace
// clears the helper's locality (back to "no area" — they get no scheduled
// invites in the dispatch crons).
type setLocalityRequest struct {
	Locality string `json:"locality"`
}

// SetLocality handles PATCH /admin/workers/:id/locality. Validates the
// supplied name against the active localities table; clears on empty.
// Permission piggy-backs on workers.suspend since both are admin moderation
// actions of the same blast radius.
func (h *Handler) SetLocality(c *fiber.Ctx) error {
	id := c.Params("id")
	var req setLocalityRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	canonical, err := h.repo.SetLocality(c.UserContext(), id, req.Locality)
	if err != nil {
		log.Warn().Err(err).Str("worker_id", id).Msg("[crm.workers] set locality failed")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "worker.locality.set", id, nil, canonical)
	return c.JSON(fiber.Map{"ok": true, "locality": canonical})
}

// List handles GET /workers.
func (h *Handler) List(c *fiber.Ctx) error {
	f := parseListFilter(c)
	out, err := h.repo.List(c.UserContext(), f)
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
}

// Get handles GET /workers/:id.
func (h *Handler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	d, err := h.repo.Get(c.UserContext(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		log.Error().Err(err).Msg("[crm.workers] get failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	// Audit single-worker PII reads (audit NEW-A1-002 partial).
	h.audit(c, "worker.view", id, nil, nil)
	return c.JSON(d)
}

// Jobs handles GET /workers/:id/jobs.
func (h *Handler) Jobs(c *fiber.Ctx) error {
	id := c.Params("id")
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	out, err := h.repo.Jobs(c.UserContext(), id, limit)
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] jobs failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	// Audit scoped PII read (audit A5-02 broader). Per-worker job history
	// reveals income detail; bounded volume.
	h.audit(c, "worker.jobs.list", id, nil, fiber.Map{"count": len(out)})
	return c.JSON(fiber.Map{"jobs": out})
}

// ActiveJob handles GET /workers/:id/active-job.
func (h *Handler) ActiveJob(c *fiber.Ctx) error {
	has, id, err := h.repo.HasActiveJob(c.UserContext(), c.Params("id"))
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] active job failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"has_active": has, "booking_id": id})
}

// LivePins handles GET /workers/live.
func (h *Handler) LivePins(c *fiber.Ctx) error {
	out, err := h.repo.LivePins(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.workers] live pins failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"pins": out})
}

// Approve handles POST /workers/:id/approve.
func (h *Handler) Approve(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.Approve(c.UserContext(), id); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.approve", id, nil, nil)
	adminID, _ := c.Locals("crmAdminID").(string)
	h.fireWebhook(c.UserContext(), webhooks.EventAdminWorkerApproved, webhooks.AdminWorkerActionEvent{
		WorkerID:   id,
		Action:     "approved",
		AdminID:    adminID,
		OccurredAt: time.Now().UTC(),
	})
	return c.JSON(fiber.Map{"ok": true})
}

// Reject handles POST /workers/:id/reject.
func (h *Handler) Reject(c *fiber.Ctx) error {
	var req RejectRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	if err := h.repo.Reject(c.UserContext(), id); err != nil {
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
	if err := h.repo.Suspend(c.UserContext(), id, req.Reason); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.suspend", id, nil, req.Reason)
	adminID, _ := c.Locals("crmAdminID").(string)
	h.fireWebhook(c.UserContext(), webhooks.EventAdminWorkerSuspended, webhooks.AdminWorkerActionEvent{
		WorkerID:   id,
		Action:     "suspended",
		Reason:     req.Reason,
		AdminID:    adminID,
		OccurredAt: time.Now().UTC(),
	})
	return c.JSON(fiber.Map{"ok": true})
}

// Unsuspend handles POST /workers/:id/unsuspend.
func (h *Handler) Unsuspend(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.Unsuspend(c.UserContext(), id); err != nil {
		return h.errResp(c, err)
	}
	h.audit(c, "worker.unsuspend", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

// ForceOffline handles POST /workers/:id/force-offline.
func (h *Handler) ForceOffline(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.ForceOffline(c.UserContext(), id); err != nil {
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
	if err := h.repo.SetCategories(c.UserContext(), id, req.Categories); err != nil {
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
	h.recorder.Log(c.UserContext(), audit.Entry{
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
