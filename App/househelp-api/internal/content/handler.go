package content

import (
	"encoding/json"
	"fmt"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the content module.
type Handler struct {
	service *Service
}

// NewHandler creates a new content handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterPublicRoutes mounts public content routes (no auth required).
// Used by the React Native app.
func (h *Handler) RegisterPublicRoutes(router fiber.Router) {
	router.Get("/home", h.GetHome)
	router.Get("/screens/:key", h.GetScreen)
	router.Get("/services", h.GetServices)
	router.Get("/faqs", h.GetFAQs)
}

// RegisterAdminContentRoutes mounts admin content routes (requires manage_content permission).
func (h *Handler) RegisterAdminContentRoutes(router fiber.Router) {
	banners := router.Group("/content/banners", middleware.RequirePermission("manage_content"))
	banners.Get("/", h.AdminGetBanners)
	banners.Post("/", h.AdminCreateBanner)
	banners.Patch("/:id", h.AdminUpdateBanner)
	banners.Delete("/:id", h.AdminDeleteBanner)

	screens := router.Group("/content/screens", middleware.RequirePermission("manage_content"))
	screens.Get("/", h.AdminGetScreens)
	screens.Patch("/:key", h.AdminUpdateScreen)

	// NOTE: /admin/services routes are handled by the services package handler,
	// registered separately in main.go. Do not add them here.
}

// --- Public handlers ---

// GetHome handles GET /app/home.
func (h *Handler) GetHome(c *fiber.Ctx) error {
	content, err := h.service.GetAppHomeContent(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get home content")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load home content",
		})
	}
	return c.JSON(content)
}

// GetScreen handles GET /app/screens/:key.
func (h *Handler) GetScreen(c *fiber.Ctx) error {
	key := c.Params("key")
	if key == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "screen key is required",
		})
	}

	screen, err := h.service.GetScreenContent(c.Context(), key)
	if err != nil {
		log.Error().Err(err).Str("key", key).Msg("failed to get screen content")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load screen content",
		})
	}

	if screen == nil {
		return c.JSON(fiber.Map{
			"screen_key": key,
			"content":    fiber.Map{},
		})
	}

	return c.JSON(screen)
}

// GetServices handles GET /app/services.
func (h *Handler) GetServices(c *fiber.Ctx) error {
	services, err := h.service.GetActiveServices(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get services")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load services",
		})
	}
	return c.JSON(fiber.Map{"service_categories": services})
}

// GetFAQs handles GET /app/faqs.
func (h *Handler) GetFAQs(c *fiber.Ctx) error {
	faqs, err := h.service.GetActiveFAQs(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get FAQs")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load FAQs",
		})
	}
	return c.JSON(fiber.Map{"faqs": faqs})
}

// --- Admin handlers ---

// AdminGetBanners handles GET /admin/content/banners.
func (h *Handler) AdminGetBanners(c *fiber.Ctx) error {
	banners, err := h.service.GetAllBanners(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get all banners")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load banners",
		})
	}
	return c.JSON(fiber.Map{"banners": banners})
}

// AdminCreateBanner handles POST /admin/content/banners.
func (h *Handler) AdminCreateBanner(c *fiber.Ctx) error {
	var req CreateBannerRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	adminID, _ := c.Locals("adminID").(string)
	banner := &Banner{
		Title:        req.Title,
		Subtitle:     req.Subtitle,
		ImageURL:     req.ImageURL,
		TapAction:    req.TapAction,
		DisplayOrder: req.DisplayOrder,
		IsActive:     req.IsActive,
		StartsAt:     req.StartsAt,
		EndsAt:       req.EndsAt,
		CreatedBy:    adminID,
	}

	if err := h.service.CreateBanner(c.Context(), banner); err != nil {
		log.Error().Err(err).Msg("failed to create banner")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to create banner",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(banner)
}

// AdminUpdateBanner handles PATCH /admin/content/banners/:id.
func (h *Handler) AdminUpdateBanner(c *fiber.Ctx) error {
	bannerID := c.Params("id")
	if !validator.IsUUID(bannerID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid banner id"})
	}

	var req CreateBannerRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	banner := &Banner{
		ID:           bannerID,
		Title:        req.Title,
		Subtitle:     req.Subtitle,
		ImageURL:     req.ImageURL,
		TapAction:    req.TapAction,
		DisplayOrder: req.DisplayOrder,
		IsActive:     req.IsActive,
		StartsAt:     req.StartsAt,
		EndsAt:       req.EndsAt,
	}

	if err := h.service.UpdateBanner(c.Context(), banner); err != nil {
		log.Error().Err(err).Msg("failed to update banner")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to update banner",
		})
	}

	return c.JSON(banner)
}

// AdminDeleteBanner handles DELETE /admin/content/banners/:id (soft delete).
func (h *Handler) AdminDeleteBanner(c *fiber.Ctx) error {
	bannerID := c.Params("id")
	if !validator.IsUUID(bannerID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid banner id"})
	}

	if err := h.service.DeleteBanner(c.Context(), bannerID); err != nil {
		log.Error().Err(err).Msg("failed to delete banner")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to delete banner",
		})
	}

	return c.JSON(fiber.Map{"message": "banner deleted"})
}

// AdminGetScreens handles GET /admin/content/screens.
func (h *Handler) AdminGetScreens(c *fiber.Ctx) error {
	screens, err := h.service.GetAllScreenContents(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get screen contents")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load screens",
		})
	}
	return c.JSON(fiber.Map{"screens": screens})
}

// AdminUpdateScreen handles PATCH /admin/content/screens/:key.
func (h *Handler) AdminUpdateScreen(c *fiber.Ctx) error {
	screenKey := c.Params("key")

	var req UpdateScreenContentRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	// Validate that content is valid JSON.
	if !json.Valid(req.Content) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "content must be valid JSON",
		})
	}

	// Validate content conforms to the app_screens schema.
	if err := validateScreenContentSchema(req.Content); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	adminID, _ := c.Locals("adminID").(string)
	if err := h.service.UpdateScreenContent(c.Context(), screenKey, req.Content, adminID); err != nil {
		log.Error().Err(err).Msg("failed to update screen content")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to update screen content",
		})
	}

	return c.JSON(fiber.Map{"message": "screen content updated"})
}

// validateScreenContentSchema validates that content conforms to the app_screens JSON schema.
// Expected shape: {"hero_title": "", "hero_subtitle": "", "cta_text": "", "empty_state_text": "", "sections": []}
func validateScreenContentSchema(content json.RawMessage) error {
	var m map[string]interface{}
	if err := json.Unmarshal(content, &m); err != nil {
		return fmt.Errorf("content must be a JSON object")
	}

	// Optional string fields.
	stringFields := []string{"hero_title", "hero_subtitle", "cta_text", "empty_state_text"}
	for _, field := range stringFields {
		if v, ok := m[field]; ok {
			if _, ok := v.(string); !ok {
				return fmt.Errorf("field '%s' must be a string", field)
			}
		}
	}

	// Optional sections array field.
	if sections, ok := m["sections"]; ok {
		if _, ok := sections.([]interface{}); !ok {
			return fmt.Errorf("field 'sections' must be an array")
		}
	}

	return nil
}

// AdminGetServices handles GET /admin/services.
func (h *Handler) AdminGetServices(c *fiber.Ctx) error {
	services, err := h.service.GetAllServiceCategories(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get all service categories")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load services",
		})
	}
	return c.JSON(fiber.Map{"services": services})
}

// AdminCreateService handles POST /admin/services.
func (h *Handler) AdminCreateService(c *fiber.Ctx) error {
	var req CreateServiceCategoryRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	adminID, _ := c.Locals("adminID").(string)
	sc := &ServiceCategory{
		Name:           req.Name,
		Description:    req.Description,
		IconURL:        req.IconURL,
		BasePriceCents: req.BasePriceCents,
		IsActive:       req.IsActive,
		DisplayOrder:   req.DisplayOrder,
		CreatedBy:      adminID,
	}

	if err := h.service.CreateServiceCategory(c.Context(), sc); err != nil {
		log.Error().Err(err).Msg("failed to create service category")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to create service",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(sc)
}

// AdminUpdateService handles PATCH /admin/services/:id.
func (h *Handler) AdminUpdateService(c *fiber.Ctx) error {
	serviceID := c.Params("id")
	if !validator.IsUUID(serviceID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid service id"})
	}

	var req CreateServiceCategoryRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	sc := &ServiceCategory{
		ID:             serviceID,
		Name:           req.Name,
		Description:    req.Description,
		IconURL:        req.IconURL,
		BasePriceCents: req.BasePriceCents,
		IsActive:       req.IsActive,
		DisplayOrder:   req.DisplayOrder,
	}

	if err := h.service.UpdateServiceCategory(c.Context(), sc); err != nil {
		log.Error().Err(err).Msg("failed to update service category")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to update service",
		})
	}

	return c.JSON(sc)
}

// AdminDeleteService handles DELETE /admin/services/:id (soft delete).
func (h *Handler) AdminDeleteService(c *fiber.Ctx) error {
	serviceID := c.Params("id")
	if !validator.IsUUID(serviceID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid service id"})
	}

	if err := h.service.DeleteServiceCategory(c.Context(), serviceID); err != nil {
		log.Error().Err(err).Msg("failed to delete service category")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to delete service",
		})
	}

	return c.JSON(fiber.Map{"message": "service deleted"})
}
