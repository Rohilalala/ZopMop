package middleware

import (
	"encoding/json"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// Idempotency caches the response body keyed by Idempotency-Key + user_id for 10 minutes.
// First call executes; retries return the cached response.
func Idempotency(rdb *redis.Client, ttl time.Duration) fiber.Handler {
	return func(c *fiber.Ctx) error {
		key := c.Get("Idempotency-Key")
		if key == "" {
			return c.Next()
		}
		userID, _ := c.Locals("user_id").(string)
		cacheKey := "idem:" + userID + ":" + key

		if cached, err := rdb.Get(c.Context(), cacheKey).Bytes(); err == nil && len(cached) > 0 {
			var stored struct {
				Status int             `json:"status"`
				Body   json.RawMessage `json:"body"`
			}
			if err := json.Unmarshal(cached, &stored); err == nil {
				c.Status(stored.Status)
				c.Set("Content-Type", "application/json")
				c.Set("X-Idempotent-Replay", "true")
				return c.Send(stored.Body)
			}
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
			if setErr := rdb.Set(c.Context(), cacheKey, payload, ttl).Err(); setErr != nil {
				log.Warn().Err(setErr).Msg("idempotency cache set failed")
			}
		}
		return nil
	}
}
