package services

import (
	"strings"

	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the services catalog.
type Handler struct {
	svc *Catalog
}

// NewHandler creates a new services handler.
func NewHandler(svc *Catalog) *Handler {
	return &Handler{svc: svc}
}

// RegisterPublicRoutes mounts public service routes (no auth required).
func (h *Handler) RegisterPublicRoutes(router fiber.Router) {
	router.Get("/", h.List)
	router.Get("/:id/details", h.GetDetails)
	router.Get("/:id/addons", h.GetAddons)
}

// RegisterAdminRoutes mounts admin service management routes.
// Requires admin middleware to be applied by the caller.
func (h *Handler) RegisterAdminRoutes(router fiber.Router) {
	router.Get("/", h.ListAll)
	router.Post("/", h.Create)
	router.Patch("/:id", h.Update)
	router.Delete("/:id", h.Delete)
}

// List handles GET /services — returns all active services.
func (h *Handler) List(c *fiber.Ctx) error {
	list, err := h.svc.List(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to list services")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch services"})
	}
	return c.JSON(fiber.Map{"services": list})
}

// GetDetails handles GET /services/:id/details.
func (h *Handler) GetDetails(c *fiber.Ctx) error {
	serviceID := c.Params("id")
	if !validator.IsUUID(serviceID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid service id"})
	}
	details, err := h.svc.GetDetails(c.Context(), serviceID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "service not found"})
		}
		log.Error().Err(err).Str("service_id", serviceID).Msg("failed to get service details")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch service details"})
	}
	return c.JSON(details)
}

// GetAddons handles GET /services/:id/addons.
func (h *Handler) GetAddons(c *fiber.Ctx) error {
	serviceID := c.Params("id")
	if !validator.IsUUID(serviceID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid service id"})
	}
	addons, err := h.svc.GetAddons(c.Context(), serviceID)
	if err != nil {
		log.Error().Err(err).Str("service_id", serviceID).Msg("failed to get service addons")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch addons"})
	}
	return c.JSON(fiber.Map{"addons": addons})
}

// ── Admin handlers ────────────────────────────────────────────────────────────

// ListAll handles GET /admin/services — returns all services including inactive.
func (h *Handler) ListAll(c *fiber.Ctx) error {
	list, err := h.svc.ListAll(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to list all services")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch services"})
	}
	return c.JSON(fiber.Map{"services": list})
}

// Update handles PATCH /admin/services/:id — partial update of a service.
func (h *Handler) Update(c *fiber.Ctx) error {
	serviceID := c.Params("id")
	if !validator.IsUUID(serviceID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid service id"})
	}
	var req AdminUpdateServiceRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	// Reject explicitly empty or whitespace-only names.
	if req.Name != "" && strings.TrimSpace(req.Name) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name cannot be blank"})
	}
	// Reject zero or negative prices if price is being updated.
	if req.BasePriceCents != nil && *req.BasePriceCents <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "base_price_cents must be positive"})
	}
	svc, err := h.svc.Update(c.Context(), serviceID, req)
	if err != nil {
		log.Error().Err(err).Str("service_id", serviceID).Msg("failed to update service")
		if err.Error() == "service not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "service not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update service"})
	}
	return c.JSON(svc)
}

// Create handles POST /admin/services — create a new service category.
func (h *Handler) Create(c *fiber.Ctx) error {
	var req AdminCreateServiceRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if req.Name == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name is required"})
	}
	if req.BasePriceCents <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "base_price_cents must be positive"})
	}
	svc, err := h.svc.Create(c.Context(), req)
	if err != nil {
		log.Error().Err(err).Msg("failed to create service")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create service"})
	}
	return c.Status(fiber.StatusCreated).JSON(svc)
}

// Delete handles DELETE /admin/services/:id — permanently remove a service category.
func (h *Handler) Delete(c *fiber.Ctx) error {
	serviceID := c.Params("id")
	if !validator.IsUUID(serviceID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid service id"})
	}
	if err := h.svc.Delete(c.Context(), serviceID); err != nil {
		log.Error().Err(err).Str("service_id", serviceID).Msg("failed to delete service")
		if err.Error() == "service not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "service not found"})
		}
		if strings.Contains(err.Error(), "violates foreign key constraint") {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "service has existing bookings — deactivate instead of deleting"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete service"})
	}
	return c.JSON(fiber.Map{"ok": true})
}
