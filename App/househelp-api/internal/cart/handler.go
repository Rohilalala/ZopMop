package cart

import (
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the cart module.
type Handler struct {
	service *Service
}

// NewHandler creates a new cart handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts cart routes (all require JWT auth).
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Get("/", h.GetCart)
	router.Post("/add", h.AddItem)
	router.Delete("/items/:id", h.RemoveItem)
	router.Delete("/", h.ClearCart)
}

// GetCart handles GET /cart.
func (h *Handler) GetCart(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	cart, err := h.service.GetCart(c.UserContext(), userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to get cart")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch cart"})
	}
	return c.JSON(cart)
}

// AddItem handles POST /cart/add.
func (h *Handler) AddItem(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req AddItemRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	cart, err := h.service.AddItem(c.UserContext(), userID, req)
	if err != nil {
		if err.Error() == "invalid service: service not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "service not found"})
		}
		log.Error().Err(err).Str("user_id", userID).Msg("failed to add cart item")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to add item"})
	}
	return c.Status(fiber.StatusOK).JSON(cart)
}

// RemoveItem handles DELETE /cart/items/:id.
func (h *Handler) RemoveItem(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	itemID := c.Params("id")
	if itemID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "item id required"})
	}
	if !validator.IsUUID(itemID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid item id"})
	}

	cart, err := h.service.RemoveItem(c.UserContext(), userID, itemID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "item not found"})
		}
		log.Error().Err(err).Str("user_id", userID).Str("item_id", itemID).Msg("failed to remove cart item")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to remove item"})
	}
	return c.JSON(cart)
}

// ClearCart handles DELETE /cart.
func (h *Handler) ClearCart(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	if err := h.service.Clear(c.UserContext(), userID); err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to clear cart")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to clear cart"})
	}
	return c.SendStatus(fiber.StatusNoContent)
}
