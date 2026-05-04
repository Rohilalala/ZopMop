package middleware

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// SduiAdminAuth gates the SDUI /admin routes:
//   - role must be "admin"
//   - Redis-backed token bucket: 60 req/min per admin
//
// Reuses the broader AdminMiddleware/AuthMiddleware for JWT + permission load.
// This wrapper is layered on top to keep SDUI rate-limit policy independent of
// the generic admin limiter.
func SduiAdminAuth(rdb *redis.Client) fiber.Handler {
	const limitPerMinute = 60

	return func(c *fiber.Ctx) error {
		role, _ := c.Locals("role").(string)
		if role != "admin" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "admin role required",
			})
		}

		userID, _ := c.Locals("userID").(string)
		if userID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "authentication required",
			})
		}

		if rdb == nil {
			return c.Next()
		}

		minuteEpoch := time.Now().Unix() / 60
		key := fmt.Sprintf("sdui:admin:rl:%s:%d", userID, minuteEpoch)

		ctx, cancel := context.WithTimeout(c.UserContext(), 500*time.Millisecond)
		defer cancel()

		count, err := rdb.Incr(ctx, key).Result()
		if err != nil {
			log.Warn().Err(err).Msg("[sdui] admin rate limiter Redis Incr failed; allowing")
			return c.Next()
		}
		if count == 1 {
			_ = rdb.Expire(ctx, key, 65*time.Second).Err()
		}
		c.Set("X-RateLimit-Limit", strconv.Itoa(limitPerMinute))
		c.Set("X-RateLimit-Remaining", strconv.Itoa(maxInt(0, limitPerMinute-int(count))))

		if count > int64(limitPerMinute) {
			c.Set("Retry-After", "60")
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
				"error":       "admin rate limit exceeded",
				"retry_after": 60,
			})
		}
		return c.Next()
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
