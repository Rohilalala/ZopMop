package middleware

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// AdminPermissions represents the cached admin permissions.
type AdminPermissions struct {
	AdminID     string   `json:"admin_id"`
	Permissions []string `json:"permissions"`
}

const adminCacheTTL = 5 * time.Minute

// AdminMiddleware checks that the authenticated user is an admin
// and loads their permissions (cached in Redis for 5 minutes).
func AdminMiddleware(db *pgxpool.Pool, rdb *redis.Client) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, ok := c.Locals("userID").(string)
		if !ok || userID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "authentication required",
			})
		}

		role, _ := c.Locals("role").(string)
		if role != "admin" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "insufficient permissions",
			})
		}

		// Try to load permissions from Redis cache.
		cacheKey := fmt.Sprintf("admin:perms:%s", userID)
		ctx := context.Background()

		cachedPerms, err := rdb.Get(ctx, cacheKey).Result()
		if err == nil {
			var perms AdminPermissions
			if jsonErr := json.Unmarshal([]byte(cachedPerms), &perms); jsonErr == nil {
				c.Locals("adminID", perms.AdminID)
				c.Locals("permissions", perms.Permissions)
				return c.Next()
			}
			log.Warn().Err(err).Msg("failed to unmarshal cached admin permissions")
		}

		// Cache miss — load from database.
		queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		var adminID string
		var permissionsJSON []byte

		err = db.QueryRow(queryCtx,
			`SELECT a.id, a.permissions FROM admin_users a
			 WHERE a.user_id = $1`,
			userID,
		).Scan(&adminID, &permissionsJSON)
		if err != nil {
			log.Error().Err(err).Str("user_id", userID).Msg("admin lookup failed")
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "insufficient permissions",
			})
		}

		var permissions []string
		if err := json.Unmarshal(permissionsJSON, &permissions); err != nil {
			log.Error().Err(err).Msg("failed to parse admin permissions")
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "internal server error",
			})
		}

		// Cache permissions in Redis.
		permsData := AdminPermissions{
			AdminID:     adminID,
			Permissions: permissions,
		}
		permsJSON, err := json.Marshal(permsData)
		if err != nil {
			log.Error().Err(err).Msg("failed to marshal admin permissions for cache")
		} else {
			if cacheErr := rdb.Set(ctx, cacheKey, permsJSON, adminCacheTTL).Err(); cacheErr != nil {
				log.Warn().Err(cacheErr).Msg("failed to cache admin permissions")
			}
		}

		c.Locals("adminID", adminID)
		c.Locals("permissions", permissions)

		return c.Next()
	}
}

// RequirePermission returns a Fiber handler that checks if the current admin
// has the specified permission. Must be used after AdminMiddleware.
func RequirePermission(permission string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		permissions, ok := c.Locals("permissions").([]string)
		if !ok {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "insufficient permissions",
			})
		}

		for _, p := range permissions {
			if p == permission {
				return c.Next()
			}
		}

		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"error": "insufficient permissions",
		})
	}
}
