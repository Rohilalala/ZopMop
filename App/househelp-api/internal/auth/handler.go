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

// RegisterRoutes mounts public auth routes onto the given router group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/send-otp", h.SendOTP)
	router.Post("/verify-otp", h.VerifyOTP)
	router.Post("/firebase", h.VerifyFirebase)
}

// RegisterMeRoutes mounts authenticated profile routes (requires JWT middleware applied by caller).
func (h *Handler) RegisterMeRoutes(router fiber.Router) {
	router.Get("/", h.Me)
	router.Put("/", h.UpdateMe)
}

// SendOTP handles POST /auth/send-otp.
func (h *Handler) SendOTP(c *fiber.Ctx) error {
	var req OTPRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	otp, err := h.service.SendOTP(c.Context(), req.Phone)
	if err != nil {
		log.Error().Err(err).Str("phone", req.Phone).Msg("failed to send OTP")

		var otpLocked *ErrOTPLocked
		if errors.As(err, &otpLocked) {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	response := fiber.Map{"message": "OTP sent successfully"}
	if otp != "" {
		response["otp"] = otp
		response["note"] = "OTP included in response for development only"
	}
	return c.Status(fiber.StatusOK).JSON(response)
}

// VerifyFirebase handles POST /auth/firebase.
func (h *Handler) VerifyFirebase(c *fiber.Ctx) error {
	var req FirebaseAuthRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if req.FirebaseToken == "" {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "firebase_token is required"})
	}

	loginResp, err := h.service.VerifyFirebaseToken(c.Context(), req.FirebaseToken)
	if err != nil {
		log.Error().Err(err).Msg("firebase auth failed")

		var accountSuspended *ErrAccountSuspended
		if errors.As(err, &accountSuspended) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": err.Error()})
	}

	return c.Status(fiber.StatusOK).JSON(loginResp)
}

// VerifyOTP handles POST /auth/verify-otp.
func (h *Handler) VerifyOTP(c *fiber.Ctx) error {
	var req OTPVerifyRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	loginResp, err := h.service.VerifyOTP(c.Context(), req.Phone, req.Code)
	if err != nil {
		log.Error().Err(err).Str("phone", req.Phone).Msg("OTP verification failed")

		status := fiber.StatusUnauthorized
		var otpLocked *ErrOTPLocked
		var accountSuspended *ErrAccountSuspended

		if errors.As(err, &otpLocked) {
			status = fiber.StatusTooManyRequests
		} else if errors.As(err, &accountSuspended) {
			status = fiber.StatusForbidden
		}
		return c.Status(status).JSON(fiber.Map{"error": err.Error()})
	}

	return c.Status(fiber.StatusOK).JSON(loginResp)
}

// Me handles GET /me — returns the authenticated user's profile.
func (h *Handler) Me(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	user, err := h.service.GetMe(c.Context(), userID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
		}
		log.Error().Err(err).Str("user_id", userID).Msg("failed to get profile")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch profile"})
	}

	return c.JSON(user)
}

// UpdateMe handles PUT /me — updates name and/or email.
func (h *Handler) UpdateMe(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req UpdateProfileRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	user, err := h.service.UpdateProfile(c.Context(), userID, req)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to update profile")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update profile"})
	}

	return c.JSON(user)
}
