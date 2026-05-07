package flags

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
)

// Handler is the HTTP layer for flags.
type Handler struct {
	svc        *Service
	recorder   *audit.Recorder
	dispatcher *webhooks.Dispatcher
}

// NewHandler constructs the flags Handler.
func NewHandler(svc *Service, recorder *audit.Recorder) *Handler {
	return &Handler{svc: svc, recorder: recorder}
}

// SetDispatcher wires the outbound webhook dispatcher.
func (h *Handler) SetDispatcher(d *webhooks.Dispatcher) { h.dispatcher = d }

func (h *Handler) fireWebhook(ctx context.Context, event string, payload any) {
	if h.dispatcher == nil {
		return
	}
	h.dispatcher.Dispatch(ctx, event, payload)
}

// RegisterRoutes mounts /flags/* under the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	read := middleware.RequirePermission("flags.read")
	r.Get("/flags", read, h.List)
	r.Get("/flags/snapshots", read, h.ListSnapshots)
	r.Put("/flags/:key", middleware.RequirePermission("flags.update"), h.Update)
	r.Post("/flags/snapshots/:id/rollback", middleware.RequirePermission("flags.rollback"), h.Rollback)
}

// List returns all flag defs + current values.
func (h *Handler) List(c *fiber.Ctx) error {
	out, err := h.svc.List(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.flags] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"flags": out})
}

// Update sets a single flag value.
type updateBody struct {
	Value  any    `json:"value"`
	Reason string `json:"reason"`
}

// Update is PUT /flags/:key.
func (h *Handler) Update(c *fiber.Ctx) error {
	key := c.Params("key")
	if key == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "key required"})
	}
	var body updateBody
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}

	oldVal, err := h.svc.Set(c.UserContext(), key, body.Value)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	diff := map[string]any{key: map[string]any{"before": oldVal, "after": body.Value}}

	if err := h.svc.SaveSnapshot(c.UserContext(), adminID, adminEmail, body.Reason, diff); err != nil {
		log.Error().Err(err).Msg("[crm.flags] snapshot save failed")
	}

	if h.recorder != nil {
		h.recorder.Log(c.UserContext(), audit.Entry{
			AdminID:    adminID,
			AdminEmail: adminEmail,
			Action:     "flag.update",
			Module:     "flags",
			TargetType: "flag",
			TargetID:   key,
			Before:     oldVal,
			After:      body.Value,
			IPAddress:  c.IP(),
			UserAgent:  c.Get("User-Agent"),
			RequestID:  c.Get("X-Request-ID"),
		})
	}

	h.fireWebhook(c.UserContext(), webhooks.EventAdminFlagChanged, webhooks.AdminFlagChangedEvent{
		Key:        key,
		OldValue:   oldVal,
		NewValue:   body.Value,
		AdminID:    adminID,
		OccurredAt: time.Now().UTC(),
	})

	return c.JSON(fiber.Map{"ok": true, "key": key, "value": body.Value})
}

// ListSnapshots returns recent snapshots for the rollback UI.
func (h *Handler) ListSnapshots(c *fiber.Ctx) error {
	out, err := h.svc.ListSnapshots(c.UserContext(), 50)
	if err != nil {
		log.Error().Err(err).Msg("[crm.flags] list snapshots failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"snapshots": out})
}

// Rollback applies a snapshot.
func (h *Handler) Rollback(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "snapshot id required"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)

	if err := h.svc.Rollback(c.UserContext(), id, adminID, adminEmail); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	if h.recorder != nil {
		h.recorder.Log(c.UserContext(), audit.Entry{
			AdminID:    adminID,
			AdminEmail: adminEmail,
			Action:     "flag.rollback",
			Module:     "flags",
			TargetType: "snapshot",
			TargetID:   id,
			IPAddress:  c.IP(),
			UserAgent:  c.Get("User-Agent"),
			RequestID:  c.Get("X-Request-ID"),
		})
	}

	return c.JSON(fiber.Map{"ok": true})
}
