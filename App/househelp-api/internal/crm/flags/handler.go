package flags

import (
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

// Handler is the HTTP layer for flags.
type Handler struct {
	svc      *Service
	recorder *audit.Recorder
}

// NewHandler constructs the flags Handler.
func NewHandler(svc *Service, recorder *audit.Recorder) *Handler {
	return &Handler{svc: svc, recorder: recorder}
}

// RegisterRoutes mounts /flags/* under the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Get("/flags", h.List)
	r.Get("/flags/snapshots", h.ListSnapshots)
	r.Put("/flags/:key", h.Update)
	r.Post("/flags/snapshots/:id/rollback", h.Rollback)
}

// List returns all flag defs + current values.
func (h *Handler) List(c *fiber.Ctx) error {
	out, err := h.svc.List(c.Context())
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

	oldVal, err := h.svc.Set(c.Context(), key, body.Value)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	diff := map[string]any{key: map[string]any{"before": oldVal, "after": body.Value}}

	if err := h.svc.SaveSnapshot(c.Context(), adminID, adminEmail, body.Reason, diff); err != nil {
		log.Error().Err(err).Msg("[crm.flags] snapshot save failed")
	}

	if h.recorder != nil {
		h.recorder.Log(c.Context(), audit.Entry{
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

	return c.JSON(fiber.Map{"ok": true, "key": key, "value": body.Value})
}

// ListSnapshots returns recent snapshots for the rollback UI.
func (h *Handler) ListSnapshots(c *fiber.Ctx) error {
	out, err := h.svc.ListSnapshots(c.Context(), 50)
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

	if err := h.svc.Rollback(c.Context(), id, adminID, adminEmail); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	if h.recorder != nil {
		h.recorder.Log(c.Context(), audit.Entry{
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
