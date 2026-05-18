// Package zoneapprovals exposes the zone-approval admin queue on the
// CRM API. Same backing service.ApproveZoneRequest / RejectZoneRequest as
// the legacy cmd/api admin surface, but wired against the CRM JWT and
// crm_audit_log so the SPA sees a unified audit trail.
package zoneapprovals

import (
	"context"
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/shift"
)

// Handler glues the existing shift.Service onto the CRM router. The
// service itself is reused — no duplicate state machine here.
type Handler struct {
	svc      *shift.Service
	recorder *audit.Recorder
}

// NewHandler constructs a Handler.
func NewHandler(svc *shift.Service, recorder *audit.Recorder) *Handler {
	return &Handler{svc: svc, recorder: recorder}
}

// RegisterRoutes mounts /zone-approvals/* on the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Get("/zone-approvals", middleware.RequirePermission("zones.approval.read"), h.List)
	r.Post("/zone-approvals/:id/approve", middleware.RequirePermission("zones.approval.approve"), h.Approve)
	r.Post("/zone-approvals/:id/reject", middleware.RequirePermission("zones.approval.reject"), h.Reject)
}

// List handles GET /admin/zone-approvals — pending review queue.
func (h *Handler) List(c *fiber.Ctx) error {
	rows, err := h.svc.ListPendingZoneApprovals(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.zone-approvals] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"requests": rows})
}

// Approve handles POST /admin/zone-approvals/:id/approve.
func (h *Handler) Approve(c *fiber.Ctx) error {
	id := c.Params("id")
	adminID, _ := c.Locals("crmAdminID").(string)
	if err := h.svc.ApproveZoneRequest(c.UserContext(), id, adminID); err != nil {
		if errors.Is(err, shift.ErrAlreadyReviewed) {
			// Admin race / stale UI — no state change, no audit, no push.
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":   "already_reviewed",
				"message": "This request was already reviewed by another admin",
			})
		}
		log.Warn().Err(err).Str("request_id", id).Msg("[crm.zone-approvals] approve failed")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "zone_approval.approve", id, nil, nil)
	return c.JSON(fiber.Map{"message": "approved"})
}

type rejectRequest struct {
	Notes string `json:"notes"`
}

// Reject handles POST /admin/zone-approvals/:id/reject.
func (h *Handler) Reject(c *fiber.Ctx) error {
	id := c.Params("id")
	adminID, _ := c.Locals("crmAdminID").(string)
	var req rejectRequest
	_ = c.BodyParser(&req)
	if err := h.svc.RejectZoneRequest(c.UserContext(), id, adminID, req.Notes); err != nil {
		if errors.Is(err, shift.ErrAlreadyReviewed) {
			// Admin race / stale UI — no state change, no audit, no push.
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":   "already_reviewed",
				"message": "This request was already reviewed by another admin",
			})
		}
		log.Warn().Err(err).Str("request_id", id).Msg("[crm.zone-approvals] reject failed")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "zone_approval.reject", id, nil, fiber.Map{"notes": req.Notes})
	return c.JSON(fiber.Map{"message": "rejected"})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID:    adminID,
		AdminEmail: adminEmail,
		Action:     action,
		Module:     "zone-approvals",
		TargetType: "zone_approval_request",
		TargetID:   target,
		Before:     before,
		After:      after,
		IPAddress:  c.IP(),
		UserAgent:  c.Get("User-Agent"),
		RequestID:  c.Get("X-Request-ID"),
	})
}

// Compile-time interface sanity check. context import retained for
// future helpers that need it.
var _ = context.Background
