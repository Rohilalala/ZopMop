package referral

import (
	"errors"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterMeRoutes mounts GET /me/referral on the given meRouter.
func (h *Handler) RegisterMeRoutes(meRouter fiber.Router) {
	meRouter.Get("/referral", h.GetReferral)
}

// RegisterRoutes mounts POST /apply on the given referrals router.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/apply", h.Apply)
}

func (h *Handler) GetReferral(c *fiber.Ctx) error {
	userID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	if userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}
	name, _ := c.Locals("name").(string)
	phone, _ := c.Locals("phone").(string)

	stats, err := h.svc.GetStats(c.UserContext(), userID, name, phone)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("referral: get stats failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load referral info"})
	}
	return c.JSON(stats)
}

func (h *Handler) Apply(c *fiber.Ctx) error {
	userID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	if userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req ApplyRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	if err := h.svc.Apply(c.UserContext(), userID, req.Code); err != nil {
		switch {
		case errors.Is(err, ErrCodeNotFound):
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "referral code not found"})
		case errors.Is(err, ErrAlreadyReferred):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "already referred", "code": "already_referred"})
		case errors.Is(err, ErrCapReached):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "referral cap reached", "code": "referral_cap_reached"})
		case errors.Is(err, ErrSelfReferral):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cannot refer yourself", "code": "self_referral"})
		default:
			log.Error().Err(err).Str("user_id", userID).Msg("referral: apply failed")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to apply referral"})
		}
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"ok": true})
}
