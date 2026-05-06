package middleware

import (
	"context"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// SuspensionChecker is the narrow interface AuthMiddleware uses to
// verify a user's suspension status on each authenticated request.
// auth.Repository satisfies this — passing the repo into
// AuthMiddleware via this interface keeps the middleware free of an
// auth-package import (avoids the import cycle the middleware
// package would otherwise hit).
//
// Audit C-8 / A5-06 chunk 16. The previous implementation read
// is_suspended from the JWT claim baked at login time; suspensions
// took up to JWT_EXPIRY_HOURS to take effect. Live DB read closes
// the gap.
type SuspensionChecker interface {
	IsSuspended(ctx context.Context, userID uuid.UUID) (bool, error)
}

// AuthCookieName is the name of the HttpOnly cookie used by browser clients
// to carry the JWT. Mobile clients (React Native / Expo SecureStore) continue
// to use the Authorization: Bearer header — the two flows are supported in
// parallel so the mobile SecureStore implementation does not need to change.
const AuthCookieName = "auth_token"

// IsUnauthenticatedPath reports whether the given request path must bypass
// the JWT auth + user-keyed rate limiter. These are server-to-server
// endpoints (gateway webhooks) that authenticate via HMAC signatures on the
// request body — there is no JWT to validate.
//
// Background: Fiber's Group(prefix, handlers...) is implemented as
// app.Use(prefix, handlers...), which registers the handlers as
// Use-middleware on the prefix path itself. A second Group() with the same
// prefix but no handlers does NOT undo that Use registration. So the
// webhook route /api/v1/payments/cashfree/webhook still picks up the
// authMiddleware that was attached to /api/v1/payments by the
// auth-protected paymentsGroup. We bypass at the middleware level instead
// of restructuring the Fiber routes (least invasive — same approach as
// the CSRF Next func skip).
func IsUnauthenticatedPath(path string) bool {
	switch path {
	case "/api/v1/payments/cashfree/webhook":
		return true
	}
	return false
}

// AuthMiddleware validates JWT tokens from either the Authorization header
// (mobile / Bearer flow) or the HttpOnly auth_token cookie (browser flow).
// On success, stores userID and role in Fiber locals.
// On failure, returns 401 with a generic error message (never stack traces).
//
// checker performs a live DB read of users.is_suspended on every
// request — the previous implementation read the bool from the JWT
// claim, which goes stale up to JWT_EXPIRY_HOURS after admin
// suspension. Audit C-8 / A5-06 chunk 16. checker may be nil only
// in tests / older binaries; nil-checker degrades to the legacy
// JWT-claim path with a one-time warning.
func AuthMiddleware(jwtKeys []JWTKey, checker SuspensionChecker) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Server-to-server webhook endpoints authenticate via HMAC signature
		// on the body — JWT auth is meaningless there. See IsUnauthenticatedPath.
		if IsUnauthenticatedPath(c.Path()) {
			return c.Next()
		}

		tokenString := ""

		if authHeader := c.Get("Authorization"); authHeader != "" {
			// Expect "Bearer <token>" format.
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
				tokenString = parts[1]
			}
		}

		// Cookie fallback for cookie-based browser sessions.
		if tokenString == "" {
			tokenString = c.Cookies(AuthCookieName)
		}

		if tokenString == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "authentication required",
			})
		}

		claims, err := ParseJWTClaims(tokenString, jwtKeys)
		if err != nil {
			log.Debug().Err(err).Msg("JWT validation failed")
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "authentication required",
			})
		}

		// Extract user ID and role from claims.
		userIDStr, ok := claims["user_id"].(string)
		if !ok || userIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "authentication required",
			})
		}

		role, _ := claims["role"].(string)

		// Live suspension check — closes the JWT-staleness gap that
		// audit A5-06 flagged. PK lookup against users.is_suspended.
		if checker != nil {
			userID, err := uuid.Parse(userIDStr)
			if err != nil {
				return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
					"error": "authentication required",
				})
			}
			suspended, err := checker.IsSuspended(c.UserContext(), userID)
			if err != nil {
				// Fail closed: this is the auth path; never pass on
				// uncertainty. 503 signals "transient — retry" while
				// not leaking the underlying DB error.
				log.Error().Err(err).Str("user_id", userIDStr).Msg("[auth] suspension check failed; failing closed")
				return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
					"error": "service temporarily unavailable",
					"code":  "AUTH_CHECK_FAILED",
				})
			}
			if suspended {
				return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
					"error": "account suspended",
					"code":  "ACCOUNT_SUSPENDED",
				})
			}
		} else if isSuspended, ok := claims["is_suspended"].(bool); ok && isSuspended {
			// Legacy JWT-claim fallback for nil-checker. Tests only.
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "account suspended",
				"code":  "ACCOUNT_SUSPENDED",
			})
		}

		// Store in Fiber locals for downstream handlers.
		c.Locals(LocalsKeyUserID, userIDStr)
		c.Locals("role", role)

		return c.Next()
	}
}

// RequireRole returns a Fiber handler that rejects the request unless the
// JWT-derived role (stored in Fiber locals by AuthMiddleware) matches one of
// the provided allowed roles. Must be chained after AuthMiddleware.
//
// This is the authorisation primitive for endpoints that are limited to a
// specific actor class — e.g. helper/pro-only workflows (accept booking,
// helper invites, location updates) that must not be callable by customer
// JWTs even though the JWT itself is valid.
func RequireRole(allowed ...string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		role, _ := c.Locals("role").(string)
		for _, r := range allowed {
			if r == role {
				return c.Next()
			}
		}
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"error": "insufficient permissions",
		})
	}
}
