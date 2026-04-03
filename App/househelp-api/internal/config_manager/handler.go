package config_manager

import (
	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the config_manager module.
type Handler struct {
	service *Service
}

// NewHandler creates a new config_manager handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterPublicRoutes mounts public config routes.
// App checks this on launch for maintenance mode and forced update.
func (h *Handler) RegisterPublicRoutes(router fiber.Router) {
	router.Get("/config", h.GetPublicConfig)
}

// RegisterAdminRoutes mounts admin config routes (requires manage_config permission).
func (h *Handler) RegisterAdminRoutes(router fiber.Router) {
	cfg := router.Group("/config", middleware.RequirePermission("manage_config"))
	cfg.Get("/", h.GetAllConfigs)
	cfg.Patch("/:key", h.UpdateConfig)
	cfg.Post("/bulk", h.BulkUpdateConfig)
}

// GetPublicConfig handles GET /app/config.
func (h *Handler) GetPublicConfig(c *fiber.Ctx) error {
	config, err := h.service.GetPublicConfig(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get public config")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load config",
		})
	}
	return c.JSON(fiber.Map{"config": config})
}

// GetAllConfigs handles GET /admin/config.
func (h *Handler) GetAllConfigs(c *fiber.Ctx) error {
	configs, err := h.service.GetAllConfigs(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get all configs")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load configs",
		})
	}
	return c.JSON(fiber.Map{"configs": configs})
}

// UpdateConfig handles PATCH /admin/config/:key.
func (h *Handler) UpdateConfig(c *fiber.Ctx) error {
	key := c.Params("key")

	var body struct {
		Value string `json:"value"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	userID, _ := c.Locals("userID").(string)

	// Get old value for logging.
	oldValue, _ := h.service.GetConfig(c.Context(), key)

	if err := h.service.SetConfig(c.Context(), key, body.Value, userID); err != nil {
		log.Error().Err(err).Str("key", key).Msg("failed to update config")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to update config",
		})
	}

	// Log change.
	h.service.LogConfigChange(c.Context(), userID, key, oldValue, body.Value)

	return c.JSON(fiber.Map{
		"message": "config updated",
		"key":     key,
		"value":   body.Value,
	})
}

// BulkUpdateConfig handles POST /admin/config/bulk.
func (h *Handler) BulkUpdateConfig(c *fiber.Ctx) error {
	var req BulkConfigUpdate
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	if len(req.Configs) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "no configs provided",
		})
	}

	userID, _ := c.Locals("userID").(string)

	if err := h.service.BulkSetConfig(c.Context(), req.Configs, userID); err != nil {
		log.Error().Err(err).Msg("failed to bulk update config")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to update configs",
		})
	}

	return c.JSON(fiber.Map{
		"message": "configs updated",
		"count":   len(req.Configs),
	})
}
