package middleware

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// AuthCookieName is the name of the HttpOnly cookie used by browser clients
// to carry the JWT. Mobile clients (React Native / Expo SecureStore) continue
// to use the Authorization: Bearer header — the two flows are supported in
// parallel so the mobile SecureStore implementation does not need to change.
const AuthCookieName = "auth_token"

// AuthMiddleware validates JWT tokens from either the Authorization header
// (mobile / Bearer flow) or the HttpOnly auth_token cookie (browser flow).
// On success, stores userID and role in Fiber locals.
// On failure, returns 401 with a generic error message (never stack traces).
func AuthMiddleware(jwtKeys []JWTKey) fiber.Handler {
	return func(c *fiber.Ctx) error {
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
		userID, ok := claims["user_id"].(string)
		if !ok || userID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "authentication required",
			})
		}

		role, _ := claims["role"].(string)

		// Check if user is suspended.
		if isSuspended, ok := claims["is_suspended"].(bool); ok && isSuspended {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "account suspended",
			})
		}

		// Store in Fiber locals for downstream handlers.
		c.Locals("userID", userID)
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
