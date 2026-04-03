package auth

import (
	"errors"

	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the auth module.
type Handler struct {
	service *Service
}

// NewHandler creates a new auth handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts auth routes onto the given router group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/send-otp", h.SendOTP)
	router.Post("/verify-otp", h.VerifyOTP)
}

// SendOTP handles POST /auth/send-otp.
// Validates the phone number and sends an OTP.
func (h *Handler) SendOTP(c *fiber.Ctx) error {
	var req OTPRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	// Validate input.
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	otp, err := h.service.SendOTP(c.Context(), req.Phone)
	if err != nil {
		log.Error().Err(err).Str("phone", req.Phone).Msg("failed to send OTP")

		// Check error type for appropriate status code.
		var otpLocked *ErrOTPLocked
		if errors.As(err, &otpLocked) {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
				"error": err.Error(),
			})
		}

		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	response := fiber.Map{
		"message": "OTP sent successfully",
	}

	// In development mode, include OTP in response for testing.
	// In production, OTP is sent via SMS only.
	if otp != "" {
		response["otp"] = otp
		response["note"] = "OTP included in response for development only"
	}

	return c.Status(fiber.StatusOK).JSON(response)
}

// VerifyOTP handles POST /auth/verify-otp.
// Validates OTP and returns a JWT token on success.
func (h *Handler) VerifyOTP(c *fiber.Ctx) error {
	var req OTPVerifyRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}

	// Validate input.
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	loginResp, err := h.service.VerifyOTP(c.Context(), req.Phone, req.Code)
	if err != nil {
		log.Error().Err(err).Str("phone", req.Phone).Msg("OTP verification failed")

		// Return appropriate status based on error type using type-safe error checking.
		status := fiber.StatusUnauthorized
		var otpLocked *ErrOTPLocked
		var accountSuspended *ErrAccountSuspended

		if errors.As(err, &otpLocked) {
			status = fiber.StatusTooManyRequests
		} else if errors.As(err, &accountSuspended) {
			status = fiber.StatusForbidden
		}

		return c.Status(status).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	return c.Status(fiber.StatusOK).JSON(loginResp)
}
