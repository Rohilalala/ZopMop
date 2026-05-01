package auth

import (
	"errors"
	"strconv"
	"time"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/logger"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the auth module.
type Handler struct {
	service      *Service
	isProduction bool
}

// NewHandler creates a new auth handler.
// isProduction toggles the Secure attribute on the httpOnly auth cookie.
// In dev (plain HTTP) Secure cookies would be dropped by the browser, so we
// only set Secure in production.
func NewHandler(service *Service, isProduction bool) *Handler {
	return &Handler{service: service, isProduction: isProduction}
}

// setAuthCookie writes the JWT as an HttpOnly+SameSite=Strict cookie so that
// cookie-based browser clients (test client / admin dashboard) never expose
// the token to JavaScript. Mobile clients also receive the token in the JSON
// body and ignore the cookie.
func (h *Handler) setAuthCookie(c *fiber.Ctx, token string, ttl time.Duration) {
	c.Cookie(&fiber.Cookie{
		Name:     middleware.AuthCookieName,
		Value:    token,
		Path:     "/",
		HTTPOnly: true,
		Secure:   h.isProduction,
		SameSite: "Strict",
		Expires:  time.Now().Add(ttl),
		MaxAge:   int(ttl.Seconds()),
	})
}

// clearAuthCookie expires the auth cookie so the browser drops it on /logout.
func (h *Handler) clearAuthCookie(c *fiber.Ctx) {
	c.Cookie(&fiber.Cookie{
		Name:     middleware.AuthCookieName,
		Value:    "",
		Path:     "/",
		HTTPOnly: true,
		Secure:   h.isProduction,
		SameSite: "Strict",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

// RegisterRoutes mounts public auth routes onto the given router group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/send-otp", h.SendOTP)
	router.Post("/verify-otp", h.VerifyOTP)
	router.Post("/firebase", h.VerifyFirebase)
	router.Post("/logout", h.Logout)
}

// RegisterMeRoutes mounts authenticated profile routes (requires JWT middleware applied by caller).
func (h *Handler) RegisterMeRoutes(router fiber.Router) {
	router.Get("/", h.Me)
	router.Put("/", h.UpdateMe)
	router.Delete("/", h.DeleteMe)
	router.Post("/onboard-pro", h.OnboardPro)
	router.Put("/fcm-token", h.UpdateFCMToken)
}

// DeleteMe handles DELETE /me — permanently (soft) deletes the caller's
// account. Required by App Store Guideline 5.1.1(v). Body is optional:
// { "reason": "..." } may capture a short user-supplied reason. Clears the
// auth cookie so cookie-based browser clients are signed out in the same
// round-trip.
func (h *Handler) DeleteMe(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req DeleteAccountRequest
	// Body is optional — ignore parse errors so clients that send an empty
	// body still succeed.
	_ = c.BodyParser(&req)
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	if err := h.service.DeleteAccount(c.Context(), userID, req.Reason); err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
		}
		log.Error().Err(err).Str("user_id", userID).Msg("failed to delete account")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete account"})
	}

	h.clearAuthCookie(c)
	return c.JSON(fiber.Map{"message": "account deleted"})
}

// Logout clears the auth cookie. Safe to call unauthenticated — cookie auth
// clients call this to evict the HttpOnly cookie; mobile / Bearer clients can
// drop the token client-side and need not call this.
func (h *Handler) Logout(c *fiber.Ctx) error {
	h.clearAuthCookie(c)
	return c.JSON(fiber.Map{"message": "logged out"})
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
		log.Error().Err(err).Str("phone_mask", logger.MaskPhone(req.Phone)).Msg("failed to send OTP")
		return mapSendOTPError(c, err)
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
		return mapVerifyFirebaseError(c, err)
	}

	h.setAuthCookie(c, loginResp.Token, h.service.JWTExpiry())
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
		log.Error().Err(err).Str("phone_mask", logger.MaskPhone(req.Phone)).Msg("OTP verification failed")
		return mapVerifyOTPError(c, err)
	}

	h.setAuthCookie(c, loginResp.Token, h.service.JWTExpiry())
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

// OnboardPro handles POST /me/onboard-pro — upgrades a user to 'pro' and creates a helper record.
func (h *Handler) OnboardPro(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req OnboardProRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	resp, err := h.service.OnboardPro(c.Context(), userID, req)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to onboard pro")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to onboard pro"})
	}

	// SECURITY: role is NOT changed here — admin approval is required. Do not
	// reissue the auth cookie/JWT; the existing customer session continues.
	return c.JSON(resp)
}

// UpdateFCMToken handles PUT /me/fcm-token.
func (h *Handler) UpdateFCMToken(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req UpdateFCMTokenRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	if err := h.service.UpdateFCMToken(c.Context(), userID, req.Token); err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to update FCM token")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update FCM token"})
	}

	return c.JSON(fiber.Map{"message": "token updated"})
}

func mapSendOTPError(c *fiber.Ctx, err error) error {
	var otpLocked *ErrOTPLocked
	if errors.As(err, &otpLocked) {
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": otpLocked.Error()})
	}
	var otpCooldown *ErrOTPCooldown
	if errors.As(err, &otpCooldown) {
		c.Set("Retry-After", strconv.Itoa(int(otpCooldown.RetryAfter.Seconds())))
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
			"error":       otpCooldown.Error(),
			"retry_after": int(otpCooldown.RetryAfter.Seconds()),
		})
	}
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to send OTP"})
}

func mapVerifyOTPError(c *fiber.Ctx, err error) error {
	var otpLocked *ErrOTPLocked
	if errors.As(err, &otpLocked) {
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": otpLocked.Error()})
	}

	var accountSuspended *ErrAccountSuspended
	if errors.As(err, &accountSuspended) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": accountSuspended.Error()})
	}

	switch {
	case errors.Is(err, ErrInvalidOTP), errors.Is(err, ErrOTPExpiredOrNotFound):
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": err.Error()})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to verify OTP"})
	}
}

func mapVerifyFirebaseError(c *fiber.Ctx, err error) error {
	var accountSuspended *ErrAccountSuspended
	if errors.As(err, &accountSuspended) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": accountSuspended.Error()})
	}

	switch {
	case errors.Is(err, ErrInvalidFirebaseToken), errors.Is(err, ErrFirebasePhoneMissing):
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid firebase token"})
	case errors.Is(err, ErrFirebaseClientUnavailable):
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "authentication provider unavailable"})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to verify firebase token"})
	}
}
