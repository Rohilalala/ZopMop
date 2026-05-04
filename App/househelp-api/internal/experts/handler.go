package experts

import (
	"errors"

	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler is the HTTP layer for /me/experts.
type Handler struct {
	service *Service
}

// NewHandler constructs a Handler.
func NewHandler(service *Service) *Handler { return &Handler{service: service} }

// RegisterRoutes mounts /experts onto the given (already-authed) router.
// Wire under the /me group so the path is /me/experts(/:helper_id).
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Get("/experts", h.List)
	router.Post("/experts/:helper_id", h.Add)
	router.Delete("/experts/:helper_id", h.Remove)
}

// List handles GET /me/experts.
func (h *Handler) List(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	out, err := h.service.List(c.UserContext(), userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("[experts] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load experts"})
	}
	return c.JSON(fiber.Map{"experts": out, "limit": MaxExpertsPerUser})
}

// Add handles POST /me/experts/:helper_id.
func (h *Handler) Add(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}
	helperID := c.Params("helper_id")
	if !validator.IsUUID(helperID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid helper id"})
	}
	if helperID == userID {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cannot add yourself as an expert"})
	}

	switch err := h.service.Add(c.UserContext(), userID, helperID); {
	case err == nil:
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"ok": true})
	case errors.Is(err, ErrHelperUnknown):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "helper not found"})
	case errors.Is(err, ErrLimitReached):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "You can have up to 5 experts. Remove one to add another.",
		})
	case errors.Is(err, ErrAlreadyAdded):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "already in your experts"})
	default:
		log.Error().Err(err).Str("user_id", userID).Str("helper_id", helperID).Msg("[experts] add failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to add expert"})
	}
}

// Remove handles DELETE /me/experts/:helper_id.
func (h *Handler) Remove(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}
	helperID := c.Params("helper_id")
	if !validator.IsUUID(helperID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid helper id"})
	}

	switch err := h.service.Remove(c.UserContext(), userID, helperID); {
	case err == nil:
		return c.JSON(fiber.Map{"ok": true})
	case errors.Is(err, ErrNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "expert not found"})
	default:
		log.Error().Err(err).Str("user_id", userID).Str("helper_id", helperID).Msg("[experts] remove failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to remove expert"})
	}
}
