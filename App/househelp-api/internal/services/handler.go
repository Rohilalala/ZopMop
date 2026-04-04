package services

import (
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
	addons, err := h.svc.GetAddons(c.Context(), serviceID)
	if err != nil {
		log.Error().Err(err).Str("service_id", serviceID).Msg("failed to get service addons")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch addons"})
	}
	return c.JSON(fiber.Map{"addons": addons})
}
