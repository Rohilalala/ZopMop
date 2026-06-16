// Package catalog exposes the service catalog (service_categories) to the CRM
// admin so prices, MRP, and the active flag can be edited live. The customer
// app reads the same table on its next fetch — there is no cache between a CRM
// edit and the app seeing it (see internal/services).
//
// It reuses internal/services' auth-agnostic Catalog business logic; only the
// auth / permission / audit wrapper here is CRM-specific.
package catalog

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/services"
	"github.com/adityarohilla/househelp-api/pkg/validator"
)

// Handler exposes read + price/MRP/active edits over the service catalog.
type Handler struct {
	catalog  *services.Catalog
	recorder *audit.Recorder
}

// NewHandler wires the shared services catalog with the CRM audit recorder.
func NewHandler(catalog *services.Catalog, recorder *audit.Recorder) *Handler {
	return &Handler{catalog: catalog, recorder: recorder}
}

// RegisterRoutes mounts the catalog admin routes onto the authed CRM group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/catalog")
	g.Get("/", middleware.RequirePermission("catalog.read"), h.List)
	g.Patch("/:id", middleware.RequirePermission("catalog.update"), h.Update)
}

// List handles GET /catalog — every service including inactive (admin view).
func (h *Handler) List(c *fiber.Ctx) error {
	list, err := h.catalog.ListAll(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.catalog] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"services": list})
}

// Update handles PATCH /catalog/:id — partial edit (price, MRP, active, etc.).
func (h *Handler) Update(c *fiber.Ctx) error {
	id := c.Params("id")
	if !validator.IsUUID(id) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid service id"})
	}
	var req services.AdminUpdateServiceRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	// Reject whitespace-only names — validator's min=1 only catches "".
	if req.Name != "" && strings.TrimSpace(req.Name) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name cannot be blank"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}
	// When both are set in the same edit, MRP must be >= price so the
	// strikethrough never shows a negative discount.
	if req.MrpCents != nil && req.BasePriceCents != nil && *req.MrpCents < *req.BasePriceCents {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "MRP must be greater than or equal to price"})
	}
	svc, err := h.catalog.Update(c.UserContext(), id, req)
	if err != nil {
		if err.Error() == "service not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "service not found"})
		}
		log.Error().Err(err).Str("service_id", id).Msg("[crm.catalog] update failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update service"})
	}
	h.audit(c, "catalog.update", id, nil, req)
	return c.JSON(svc)
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "catalog",
		TargetType: "service", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}
