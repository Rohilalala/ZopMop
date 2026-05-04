package addresses

import (
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for user addresses.
type Handler struct {
	service *Service
}

// NewHandler creates a new addresses handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts address routes onto the given router group.
// All routes require JWT authentication (applied by the caller).
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Get("/", h.List)
	router.Post("/", h.Create)
	router.Put("/:id", h.Update)
	router.Delete("/:id", h.Delete)
}

// List handles GET /addresses.
func (h *Handler) List(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	addrs, err := h.service.ListByUser(c.UserContext(), userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to list addresses")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch addresses"})
	}

	return c.JSON(fiber.Map{"addresses": addrs})
}

// Create handles POST /addresses.
func (h *Handler) Create(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req CreateAddressRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	addr, err := h.service.Create(c.UserContext(), userID, req)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to create address")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to save address"})
	}

	return c.Status(fiber.StatusCreated).JSON(addr)
}

// Update handles PUT /addresses/:id.
func (h *Handler) Update(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	addressID := c.Params("id")
	if addressID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "address id required"})
	}
	if !validator.IsUUID(addressID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid address id"})
	}

	var req UpdateAddressRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	addr, err := h.service.Update(c.UserContext(), userID, addressID, req)
	if err != nil {
		if err == pgx.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "address not found"})
		}
		log.Error().Err(err).Str("user_id", userID).Str("address_id", addressID).Msg("failed to update address")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update address"})
	}

	return c.JSON(addr)
}

// Delete handles DELETE /addresses/:id.
func (h *Handler) Delete(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	addressID := c.Params("id")
	if addressID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "address id required"})
	}
	if !validator.IsUUID(addressID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid address id"})
	}

	if err := h.service.Delete(c.UserContext(), userID, addressID); err != nil {
		if err == pgx.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "address not found"})
		}
		if err == ErrAddressInUse || err == ErrAddressHasGroup {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		log.Error().Err(err).Str("user_id", userID).Str("address_id", addressID).Msg("failed to delete address")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete address"})
	}

	return c.SendStatus(fiber.StatusNoContent)
}
