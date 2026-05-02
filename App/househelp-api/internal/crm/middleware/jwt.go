// Package middleware contains CRM-specific Fiber middleware. The user-app
// middleware in internal/middleware is intentionally NOT reused here so the
// two services stay decoupled — different JWT secrets, different session
// model, different lockout semantics.
package middleware

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/auth"
)

// JWTConfig is the runtime configuration of the JWT-validating middleware.
type JWTConfig struct {
	Secret string // CRM_JWT_SECRET
	DB     *pgxpool.Pool
}

// JWT returns a Fiber handler that validates the access token in the
// Authorization header, confirms the bound session is still active, and
// stores admin context in Fiber locals (crmAdminID, crmAdminEmail,
// crmAdminRole, crmSessionID).
//
// Returns 401 on any failure with a generic error to avoid leaking why.
func JWT(cfg JWTConfig) fiber.Handler {
	return func(c *fiber.Ctx) error {
		header := c.Get("Authorization")
		if header == "" {
			return unauthorized(c)
		}
		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return unauthorized(c)
		}

		claims, err := auth.ParseAccessToken(parts[1], cfg.Secret)
		if err != nil {
			log.Debug().Err(err).Msg("[crm.mw] JWT parse failed")
			return unauthorized(c)
		}

		if claims.AdminID == "" || claims.SessionID == "" {
			return unauthorized(c)
		}

		// Confirm session still active (not revoked, not expired). Cheap
		// indexed lookup; if pool is hot this is sub-millisecond.
		ok, err := sessionStillActive(c.Context(), cfg.DB, claims.SessionID, claims.AdminID)
		if err != nil {
			log.Error().Err(err).Msg("[crm.mw] session lookup failed")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
		}
		if !ok {
			return unauthorized(c)
		}

		c.Locals("crmAdminID", claims.AdminID)
		c.Locals("crmAdminEmail", claims.Email)
		c.Locals("crmAdminRole", claims.Role)
		c.Locals("crmSessionID", claims.SessionID)
		return c.Next()
	}
}

func unauthorized(c *fiber.Ctx) error {
	return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
}

// sessionStillActive returns true when the session row exists and is neither
// revoked nor expired. Inline so we avoid adding a method to repo just for
// middleware (keeps the auth pkg cyclical-import-free).
func sessionStillActive(ctx context.Context, db *pgxpool.Pool, sessionID, adminID string) (bool, error) {
	if db == nil {
		return false, errors.New("nil db pool")
	}
	queryCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var exists bool
	err := db.QueryRow(queryCtx, `
		SELECT EXISTS(
			SELECT 1 FROM crm_admin_sessions
			WHERE id = $1 AND admin_id = $2
			  AND revoked_at IS NULL AND expires_at > now()
		)
	`, sessionID, adminID).Scan(&exists)
	if err != nil {
		return false, err
	}
	return exists, nil
}

// RequireRole returns a Fiber handler that rejects requests where the
// authenticated admin's role is not in the allowed set. Must be chained
// after JWT.
func RequireRole(allowed ...string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		role, _ := c.Locals("crmAdminRole").(string)
		for _, r := range allowed {
			if r == role {
				return c.Next()
			}
		}
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "insufficient permissions"})
	}
}
