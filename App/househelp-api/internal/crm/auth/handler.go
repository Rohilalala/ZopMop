package auth

import (
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

// RefreshCookieName is the name of the HttpOnly cookie carrying the CRM
// refresh-token plaintext. Distinct from the user-app's auth_token cookie
// so the two never collide on the same browser.
const RefreshCookieName = "crm_refresh_token"

// CookieOptions configures the HttpOnly refresh cookie.
type CookieOptions struct {
	Domain string
	Secure bool
	Path   string
}

// Handler is the HTTP layer for auth.
type Handler struct {
	svc      *Service
	recorder *audit.Recorder
	cookie   CookieOptions
}

// NewHandler constructs the auth Handler.
func NewHandler(svc *Service, recorder *audit.Recorder, cookie CookieOptions) *Handler {
	if cookie.Path == "" {
		cookie.Path = "/"
	}
	return &Handler{svc: svc, recorder: recorder, cookie: cookie}
}

// RegisterPublicRoutes mounts unauthenticated routes (login, totp/verify,
// refresh, logout). These do NOT pass through the JWT middleware.
func (h *Handler) RegisterPublicRoutes(r fiber.Router) {
	r.Post("/login", h.Login)
	r.Post("/totp/verify", h.VerifyTOTP)
	r.Post("/refresh", h.Refresh)
	r.Post("/logout", h.Logout)
}

// RegisterAuthedRoutes mounts authenticated routes (sessions). These must be
// chained after the JWT middleware so c.Locals("adminID") is populated.
func (h *Handler) RegisterAuthedRoutes(r fiber.Router) {
	r.Get("/sessions", h.ListSessions)
	r.Delete("/sessions/:id", h.RevokeSession)
	r.Get("/me", h.Me)
}

// Login handles POST /admin/auth/login.
func (h *Handler) Login(c *fiber.Ctx) error {
	var req LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if req.Email == "" || req.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "email and password required"})
	}

	res, err := h.svc.Login(c.UserContext(), req, c.IP())
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidCredentials):
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid credentials"})
		case errors.Is(err, ErrAccountLocked):
			return c.Status(fiber.StatusLocked).JSON(fiber.Map{"error": "account locked"})
		case errors.Is(err, ErrInactive):
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "account inactive"})
		default:
			log.Error().Err(err).Msg("[crm.auth] login failed")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "login failed"})
		}
	}

	return c.JSON(LoginResponse{
		ChallengeToken: res.ChallengeToken,
		TOTPEnrolled:   res.TOTPEnrolled,
		OTPAuthURL:     res.OTPAuthURL,
	})
}

// VerifyTOTP handles POST /admin/auth/totp/verify.
func (h *Handler) VerifyTOTP(c *fiber.Ctx) error {
	var req TOTPVerifyRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if len(req.Code) != 6 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "code must be 6 digits"})
	}

	res, err := h.svc.VerifyTOTPAndIssue(c.UserContext(), req, c.Get("User-Agent"), c.IP())
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidChallenge):
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "challenge expired"})
		case errors.Is(err, ErrInvalidTOTP):
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid code"})
		case errors.Is(err, ErrInactive):
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "account inactive"})
		default:
			log.Error().Err(err).Msg("[crm.auth] totp verify failed")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "verification failed"})
		}
	}

	h.setRefreshCookie(c, res.RefreshTokenPlaintext, res.RefreshExpiresAt)

	if h.recorder != nil {
		h.recorder.Log(c.UserContext(), audit.Entry{
			AdminID:    res.Admin.ID,
			AdminEmail: res.Admin.Email,
			Action:     "auth.login",
			Module:     "auth",
			TargetType: "session",
			TargetID:   res.SessionID,
			IPAddress:  c.IP(),
			UserAgent:  c.Get("User-Agent"),
			RequestID:  c.Get("X-Request-ID"),
		})
	}

	return c.JSON(AuthSuccessResponse{
		AccessToken: res.AccessToken,
		ExpiresAt:   res.AccessExpiresAt,
		Admin:       res.Admin.ToPublic(),
	})
}

// Refresh handles POST /admin/auth/refresh. Reads cookie, rotates token,
// returns new access token. Cookie is rotated server-side as well.
func (h *Handler) Refresh(c *fiber.Ctx) error {
	cookieVal := c.Cookies(RefreshCookieName)
	if cookieVal == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "no session"})
	}
	res, err := h.svc.Refresh(c.UserContext(), cookieVal)
	if err != nil {
		h.clearRefreshCookie(c)
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "session expired"})
	}
	h.setRefreshCookie(c, res.RefreshTokenPlaintext, res.RefreshExpiresAt)
	return c.JSON(AuthSuccessResponse{
		AccessToken: res.AccessToken,
		ExpiresAt:   res.AccessExpiresAt,
		Admin:       res.Admin.ToPublic(),
	})
}

// Logout handles POST /admin/auth/logout.
func (h *Handler) Logout(c *fiber.Ctx) error {
	cookieVal := c.Cookies(RefreshCookieName)
	if cookieVal != "" {
		_ = h.svc.Logout(c.UserContext(), cookieVal)
	}
	h.clearRefreshCookie(c)

	if h.recorder != nil {
		adminID, _ := c.Locals("crmAdminID").(string)
		adminEmail, _ := c.Locals("crmAdminEmail").(string)
		h.recorder.Log(c.UserContext(), audit.Entry{
			AdminID:    adminID,
			AdminEmail: adminEmail,
			Action:     "auth.logout",
			Module:     "auth",
			IPAddress:  c.IP(),
			UserAgent:  c.Get("User-Agent"),
			RequestID:  c.Get("X-Request-ID"),
		})
	}
	return c.JSON(fiber.Map{"ok": true})
}

// ListSessions handles GET /admin/auth/sessions.
func (h *Handler) ListSessions(c *fiber.Ctx) error {
	adminID, _ := c.Locals("crmAdminID").(string)
	currentSession, _ := c.Locals("crmSessionID").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	out, err := h.svc.ListSessions(c.UserContext(), adminID, currentSession)
	if err != nil {
		log.Error().Err(err).Msg("[crm.auth] list sessions failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"sessions": out})
}

// RevokeSession handles DELETE /admin/auth/sessions/:id.
func (h *Handler) RevokeSession(c *fiber.Ctx) error {
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	id := c.Params("id")
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "session id required"})
	}
	if err := h.svc.RevokeSession(c.UserContext(), adminID, id); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "session not found"})
	}
	if h.recorder != nil {
		h.recorder.Log(c.UserContext(), audit.Entry{
			AdminID:    adminID,
			AdminEmail: adminEmail,
			Action:     "auth.revoke_session",
			Module:     "auth",
			TargetType: "session",
			TargetID:   id,
			IPAddress:  c.IP(),
			UserAgent:  c.Get("User-Agent"),
			RequestID:  c.Get("X-Request-ID"),
		})
	}
	return c.JSON(fiber.Map{"ok": true})
}

// Me returns the currently-logged-in admin. Used by the SPA on boot to
// hydrate the auth store after a silent refresh.
func (h *Handler) Me(c *fiber.Ctx) error {
	adminID, _ := c.Locals("crmAdminID").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	a, err := h.svc.GetAdmin(c.UserContext(), adminID)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	return c.JSON(a.ToPublic())
}

func (h *Handler) setRefreshCookie(c *fiber.Ctx, value string, expires time.Time) {
	c.Cookie(&fiber.Cookie{
		Name:     RefreshCookieName,
		Value:    value,
		Path:     h.cookie.Path,
		Domain:   h.cookie.Domain,
		Expires:  expires,
		HTTPOnly: true,
		Secure:   h.cookie.Secure,
		SameSite: "Strict",
	})
}

func (h *Handler) clearRefreshCookie(c *fiber.Ctx) {
	c.Cookie(&fiber.Cookie{
		Name:     RefreshCookieName,
		Value:    "",
		Path:     h.cookie.Path,
		Domain:   h.cookie.Domain,
		Expires:  time.Now().Add(-time.Hour),
		HTTPOnly: true,
		Secure:   h.cookie.Secure,
		SameSite: "Strict",
	})
}
