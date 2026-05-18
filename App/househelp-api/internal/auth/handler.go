package auth

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/adityarohilla/househelp-api/internal/booking"
	"github.com/adityarohilla/househelp-api/internal/compliance"
	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/logger"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the auth module.
type Handler struct {
	service      *Service
	rdb          *redis.Client
	isProduction bool
	compliance   *compliance.Service
	audit        *audit.Recorder
}

// NewHandler creates a new auth handler.
// isProduction toggles the Secure attribute on the httpOnly auth cookie.
// In dev (plain HTTP) Secure cookies would be dropped by the browser, so we
// only set Secure in production.
// rdb backs the per-phone OTP throttle (3 sends per 5 minutes) so abusers
// behind the same NAT cannot spam an arbitrary number a million times.
func NewHandler(service *Service, rdb *redis.Client, isProduction bool) *Handler {
	return &Handler{service: service, rdb: rdb, isProduction: isProduction}
}

// SetCompliance wires the compliance service so /me/export can stream
// user data and SoftDeleteUser flows can call into compliance helpers.
// Required for /me/export — RegisterMeRoutes panics if not set. Panics
// on nil so a deploy mistake fails loud at construction rather than
// silently disabling DPDP §11 data portability.
func (h *Handler) SetCompliance(c *compliance.Service) {
	if c == nil {
		panic("auth.Handler.SetCompliance: compliance.Service must not be nil (DPDP §11 /me/export requires it)")
	}
	h.compliance = c
}

// SetAudit wires the CRM audit recorder so /me/export and other DSAR
// requests can record an "access request" trail per DPDP §11. Required
// for /me/export — RegisterMeRoutes panics if not set. Panics on nil
// for the same loud-fail reason as SetCompliance.
func (h *Handler) SetAudit(r *audit.Recorder) {
	if r == nil {
		panic("auth.Handler.SetAudit: audit.Recorder must not be nil (DPDP §11 access-request audit trail requires it)")
	}
	h.audit = r
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
	router.Post("/refresh", h.Refresh)
	router.Post("/logout", h.Logout)
}

// RegisterMeRoutes mounts authenticated profile routes (requires JWT
// middleware applied by caller). Panics at startup if /me/export
// dependencies (compliance.Service + audit.Recorder) are not wired —
// silently disabling a compliance feature on a misconfigured deploy
// is worse than refusing to start. Catches the case where a developer
// forgets to call SetCompliance / SetAudit before mounting the route.
func (h *Handler) RegisterMeRoutes(router fiber.Router) {
	if h.compliance == nil {
		panic("auth.Handler.RegisterMeRoutes: compliance.Service not wired; call SetCompliance before mounting /me/export (DPDP §11)")
	}
	if h.audit == nil {
		panic("auth.Handler.RegisterMeRoutes: audit.Recorder not wired; call SetAudit before mounting /me/export (DPDP §11)")
	}
	router.Get("/", h.Me)
	router.Put("/", h.UpdateMe)
	router.Delete("/", h.DeleteMe)
	router.Post("/onboard-pro", h.OnboardPro)
	router.Put("/fcm-token", h.UpdateFCMToken)
	router.Get("/export", h.ExportMe)
}

// exportRateLimitWindow is the per-user gap enforced between successive
// /me/export requests. 1 hour is strict enough to prevent abuse (export
// is a heavy DB read) and lenient enough that a user who lost their
// download can re-fetch within the same workday.
const exportRateLimitWindow = time.Hour

// ExportMe handles GET /me/export — DPDP §11 / GDPR Art 20 data
// portability. Streams a JSON document containing all PII ZopMop
// holds about the authenticated user. Audit C-8 / F2D-1 chunk 11.
//
// Rate limit: 1 export per user per hour, enforced via Redis SETNX on
// `export:user:<id>` with a 3600s TTL. Returns 429 with Retry-After
// when the lock is held. Fails CLOSED on Redis unavailability — an
// export hits ~18 DB queries, so a Redis-outage attack vector that
// bypassed rate-limiting could DoS the DB. Refuse service (503) over
// silently allowing unbounded exports.
//
// Audit: each accepted export writes a `user.data_export` row to
// crm_audit_log via the injected Recorder so DPDP §11 access requests
// have a forensic trail. Required (RegisterMeRoutes asserts non-nil).
func (h *Handler) ExportMe(c *fiber.Ctx) error {
	userID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	if userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"error": "authentication required",
		})
	}

	// Rate limit: 1 export per hour per user. Fail CLOSED on Redis
	// errors — an unbounded export is a much bigger blast radius than
	// a brief 503 during a Redis outage. h.rdb is required for this
	// route; the route group at cmd/api wires the same client used by
	// /auth/send-otp's throttle, and SetCompliance/SetAudit assertions
	// guarantee the rest of the dependency graph.
	if h.rdb == nil {
		log.Error().Str("user_id", userID).Msg("[me.export] redis client missing — refusing to serve without rate-limit")
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"error": "data export rate limiter unavailable; please retry later",
			"code":  "RATE_LIMIT_UNAVAILABLE",
		})
	}
	key := "export:user:" + userID
	rlCtx, rlCancel := context.WithTimeout(c.UserContext(), 500*time.Millisecond)
	defer rlCancel()
	acquired, err := h.rdb.SetNX(rlCtx, key, "1", exportRateLimitWindow).Result()
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("[me.export] rate-limit SETNX failed; refusing to serve fail-closed")
		c.Set("Retry-After", "60")
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"error": "data export rate limiter unavailable; please retry later",
			"code":  "RATE_LIMIT_UNAVAILABLE",
		})
	}
	if !acquired {
		ttl, _ := h.rdb.TTL(rlCtx, key).Result()
		retryAfter := int(ttl.Seconds())
		if retryAfter < 1 {
			retryAfter = 60
		}
		c.Set("Retry-After", strconv.Itoa(retryAfter))
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
			"error":       "data export already requested recently; please wait before retrying",
			"code":        "EXPORT_RATE_LIMITED",
			"retry_after": retryAfter,
		})
	}

	// Audit before streaming. If the request later errors mid-stream,
	// the audit row still records that an export was requested — DPDP
	// §11 cares about the access request, not the success.
	h.audit.Log(c.UserContext(), audit.Entry{
		Action:     "user.data_export",
		Module:     "me",
		TargetType: "user",
		TargetID:   userID,
		IPAddress:  c.IP(),
		UserAgent:  c.Get("User-Agent"),
		RequestID:  c.Get("X-Request-ID"),
	})

	c.Set("Content-Type", "application/json")
	c.Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="zopmop-export-%s.json"`, time.Now().UTC().Format("2006-01-02")))
	c.Status(fiber.StatusOK)

	rows, err := h.compliance.ExportUserData(c.UserContext(), userID, c.Response().BodyWriter())
	if err != nil {
		// Headers are already on the wire; we can't switch to 5xx now.
		// Truncated body will surface as JSON parse failure on the
		// client. Log loudly so ops can investigate.
		log.Error().Err(err).Str("user_id", userID).Int("rows_so_far", rows).Msg("[me.export] streaming failed mid-payload")
		return nil
	}
	log.Info().Str("user_id", userID).Int("rows_exported", rows).Msg("[me.export] complete")
	return nil
}

// RegisterDeviceRoutes mounts authenticated device-scoped routes
// (requires JWT middleware applied by caller). This is the new
// multi-device push-token surface; the legacy single-token PUT
// /me/fcm-token continues to work via RegisterMeRoutes.
func (h *Handler) RegisterDeviceRoutes(router fiber.Router) {
	router.Post("/register", h.RegisterDevice)
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

	if err := h.service.DeleteAccount(c.UserContext(), userID, req.Reason); err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
		}
		// Customer has completed-but-unpaid Cashfree bookings — block deletion
		// with a structured 409 so the app can show a "settle pending payments"
		// prompt instead of a generic failure. App Store guideline 5.1.1(v)
		// allows blocking deletion when there's a contractual obligation.
		var unpaidErr *booking.ErrUnpaidBookings
		if errors.As(err, &unpaidErr) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":       "unpaid bookings block deletion",
				"code":        "UNPAID_BOOKINGS",
				"count":       unpaidErr.Count,
				"total_paise": unpaidErr.TotalPaise,
			})
		}
		log.Error().Err(err).Str("user_id", userID).Msg("failed to delete account")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete account"})
	}

	h.clearAuthCookie(c)
	return c.JSON(fiber.Map{"message": "account deleted"})
}

// Logout clears the auth cookie AND revokes the supplied refresh
// token if one is provided in the body. Safe to call unauthenticated.
// Cookie-based browser clients send an empty body; mobile clients
// pass {refresh_token: "..."} so the row can be marked revoked
// server-side and a stolen plaintext can't be reused.
func (h *Handler) Logout(c *fiber.Ctx) error {
	var req LogoutRequest
	_ = c.BodyParser(&req)
	if req.RefreshToken != "" && h.service != nil {
		if err := h.service.RevokeRefresh(c.UserContext(), req.RefreshToken); err != nil {
			log.Warn().Err(err).Msg("[auth] logout revoke refresh failed (non-fatal)")
		}
	}
	h.clearAuthCookie(c)
	return c.JSON(fiber.Map{"message": "logged out"})
}

// SendOTP handles POST /auth/send-otp.
//
// Post-Firebase MSG91 flow. Per-phone (3/15m) + per-IP (5/15m)
// limits are enforced inside the service via the OTPRateLimiter —
// duplicating them here would burn the counter twice per call.
// MSG91_DEV_MODE=true short-circuits the SMS call and seeds the
// hardcoded OTP "9999" so testers can complete the flow.
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

	if h.service == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "auth service not ready"})
	}

	otp, isNewUser, err := h.service.SendOTPMSG91(c.UserContext(), req.Phone, c.IP())
	if err != nil {
		log.Error().Err(err).Str("phone_mask", logger.MaskPhone(req.Phone)).Msg("failed to send OTP")
		return mapSendOTPError(c, err)
	}

	response := fiber.Map{
		"message":     "OTP sent successfully",
		"is_new_user": isNewUser,
	}
	if otp != "" {
		response["otp"] = otp
		response["note"] = "OTP included in response for development only"
	}
	return c.Status(fiber.StatusOK).JSON(response)
}

// VerifyOTP handles POST /auth/verify-otp. Hits MSG91, upserts the
// user, and issues both access + refresh tokens. The access JWT is
// also mirrored into the HttpOnly auth_token cookie so cookie-based
// browser clients (admin dashboard) keep working without code
// changes; mobile clients use the access_token from the body.
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

	if h.service == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "auth service not ready"})
	}

	loginResp, err := h.service.VerifyOTPMSG91(c.UserContext(), req.Phone, req.Code, req.HasAcceptedPrivacyPolicy)
	if err != nil {
		log.Error().Err(err).Str("phone_mask", logger.MaskPhone(req.Phone)).Msg("OTP verification failed")
		return mapVerifyOTPError(c, err)
	}

	h.setAuthCookie(c, loginResp.AccessToken, h.service.AccessTTL())
	return c.Status(fiber.StatusOK).JSON(loginResp)
}

// Refresh handles POST /auth/refresh. Rotates the refresh token —
// the prior plaintext becomes single-use, a new one is returned.
// Refresh-token plaintext travels in the JSON body so it never
// shows up in URL logs or Referer headers.
func (h *Handler) Refresh(c *fiber.Ctx) error {
	var req RefreshRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}
	if h.service == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "auth service not ready"})
	}

	loginResp, err := h.service.Refresh(c.UserContext(), req.RefreshToken)
	if err != nil {
		// Any reason maps to 401. Never leak whether the row existed,
		// was revoked, or expired — that's an oracle.
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"error": "invalid refresh token",
			"code":  "REFRESH_INVALID",
		})
	}

	h.setAuthCookie(c, loginResp.AccessToken, h.service.AccessTTL())
	return c.Status(fiber.StatusOK).JSON(loginResp)
}

// Me handles GET /me — returns the authenticated user's profile in
// the UserView shape (with `type` derived from role + the
// has_accepted_privacy_policy flag). Matches the body of
// verify-otp/refresh so clients can deserialize into a single type.
func (h *Handler) Me(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	user, err := h.service.GetMe(c.UserContext(), userID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
		}
		log.Error().Err(err).Str("user_id", userID).Msg("failed to get profile")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch profile"})
	}

	return c.JSON(user.ToView())
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

	user, err := h.service.UpdateProfile(c.UserContext(), userID, req)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to update profile")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update profile"})
	}

	return c.JSON(user.ToView())
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

	resp, err := h.service.OnboardPro(c.UserContext(), userID, req)
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

	if err := h.service.UpdateFCMToken(c.UserContext(), userID, req.Token); err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("failed to update FCM token")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update FCM token"})
	}

	return c.JSON(fiber.Map{"message": "token updated"})
}

// RegisterDevice handles POST /devices/register — upserts a per-device FCM
// token row keyed by (device_id, platform). Customers land in
// device_tokens.user_id, pros in device_tokens.worker_id; the auth
// middleware's role claim picks the column.
func (h *Handler) RegisterDevice(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}
	role, _ := c.Locals("role").(string)

	var req RegisterDeviceRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	if err := h.service.RegisterDevice(c.UserContext(), userID, role, req.FCMToken, req.Platform, req.DeviceID); err != nil {
		log.Error().Err(err).Str("user_id", userID).Str("platform", req.Platform).Msg("failed to register device token")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to register device"})
	}

	return c.JSON(fiber.Map{"ok": true})
}

func mapSendOTPError(c *fiber.Ctx, err error) error {
	if rl, ok := IsRateLimited(err); ok {
		c.Set("Retry-After", strconv.Itoa(int(rl.RetryAfter.Seconds())))
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
			"error":       "too many requests",
			"code":        "OTP_RATE_LIMITED",
			"scope":       rl.Scope,
			"retry_after": int(rl.RetryAfter.Seconds()),
		})
	}
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
	var accountSuspended *ErrAccountSuspended
	if errors.As(err, &accountSuspended) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": accountSuspended.Error()})
	}
	if errors.Is(err, ErrMSG91Misconfigured) {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "OTP gateway unavailable"})
	}
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to send OTP"})
}

func mapVerifyOTPError(c *fiber.Ctx, err error) error {
	if rl, ok := IsRateLimited(err); ok {
		c.Set("Retry-After", strconv.Itoa(int(rl.RetryAfter.Seconds())))
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
			"error":       "too many verification attempts",
			"code":        "OTP_RATE_LIMITED",
			"scope":       rl.Scope,
			"retry_after": int(rl.RetryAfter.Seconds()),
		})
	}
	var otpLocked *ErrOTPLocked
	if errors.As(err, &otpLocked) {
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": otpLocked.Error()})
	}

	var accountSuspended *ErrAccountSuspended
	if errors.As(err, &accountSuspended) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": accountSuspended.Error()})
	}

	switch {
	case errors.Is(err, ErrInvalidOTP):
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid OTP", "code": "INVALID_OTP"})
	case errors.Is(err, ErrOTPExpiredOrNotFound):
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "OTP expired or not found", "code": "OTP_EXPIRED"})
	default:
		// Avoid leaking raw err.Error() (audit B2-05). Log it; client gets
		// a generic message.
		log.Error().Err(err).Msg("[auth] verifyOTP unexpected error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to verify OTP", "code": "INTERNAL_ERROR"})
	}
}

