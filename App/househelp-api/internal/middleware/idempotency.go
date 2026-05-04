package middleware

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/pkg/database"
)

// Idempotency caches the response body keyed by Idempotency-Key + user_id for 10 minutes.
// First call executes; retries return the cached response.
//
// Failure policy: fail-closed. If Redis is down we cannot tell whether this is
// a duplicate of a prior request, so executing the handler again could cause a
// double charge / double booking. Reject with 503 + Retry-After instead.
// redis.Nil (real cache miss) still falls through to handler execution.
func Idempotency(rdb *redis.Client, ttl time.Duration) fiber.Handler {
	return func(c *fiber.Ctx) error {
		key := c.Get("Idempotency-Key")
		if key == "" {
			return c.Next()
		}
		userID, _ := c.Locals("user_id").(string)
		cacheKey := "idem:" + userID + ":" + key

		cached, err := rdb.Get(c.UserContext(), cacheKey).Bytes()
		switch {
		case err == nil && len(cached) > 0:
			var stored struct {
				Status int             `json:"status"`
				Body   json.RawMessage `json:"body"`
			}
			if jsonErr := json.Unmarshal(cached, &stored); jsonErr == nil {
				c.Status(stored.Status)
				c.Set("Content-Type", "application/json")
				c.Set("X-Idempotent-Replay", "true")
				return c.Send(stored.Body)
			}
		case database.IsRedisDown(err):
			// Fail-closed: cannot verify this isn't a retry of a prior request.
			retryAfter := 5
			log.Warn().Err(err).Str("idempotency_key", key).Msg("idempotency store unavailable; rejecting request fail-closed")
			c.Set("Retry-After", strconv.Itoa(retryAfter))
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"error":       "idempotency store unavailable",
				"retry_after": retryAfter,
			})
		}

		if err := c.Next(); err != nil {
			return err
		}
		body := c.Response().Body()
		status := c.Response().StatusCode()
		if status >= 200 && status < 300 {
			payload, _ := json.Marshal(struct {
				Status int             `json:"status"`
				Body   json.RawMessage `json:"body"`
			}{Status: status, Body: body})
			if setErr := rdb.Set(c.UserContext(), cacheKey, payload, ttl).Err(); setErr != nil {
				log.Warn().Err(setErr).Msg("idempotency cache set failed")
			}
		}
		return nil
	}
}
