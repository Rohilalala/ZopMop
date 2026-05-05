package middleware

import (
	"bytes"
	"encoding/json"
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// idemInFlightSentinel is the placeholder value stored under the cache key
// while the handler is running. A polling caller distinguishes it from a
// real cached response by exact-byte comparison.
var idemInFlightSentinel = []byte("in_flight")

const (
	idemPollInterval = 200 * time.Millisecond
	idemPollDeadline = 3 * time.Second
)

// Idempotency caches successful (2xx) responses for state-changing requests
// keyed by the Idempotency-Key header plus the authenticated user ID, and
// uses a SETNX in-flight lock to ensure that two concurrent requests with
// the same key do not both invoke the downstream handler.
//
// Behaviour:
//   - Unauthenticated requests do NOT participate. Caching under an empty
//     user namespace would let unauthenticated callers (or worse, every
//     authenticated user via a Locals-key typo — see audit E2D-1) collide
//     in a shared bucket. The header is silently ignored in that case.
//   - On any Redis error the middleware fails open: it logs a WRN and lets
//     the handler run. A transient cache outage must not break booking
//     creation. (This intentionally reverses the prior fail-closed policy.)
//   - Concurrent caller semantics: the second request polls the key every
//     200ms for up to 3s. If the sentinel is replaced with a real cached
//     response in that window, it returns the cached body. Otherwise it
//     returns 409 Conflict {"error":"duplicate request in flight"}.
//   - Non-2xx handler results are NOT cached and the in-flight sentinel is
//     deleted so the client can retry.
//
// lockTTL caps the in-flight window (a stuck handler must not block
// retries forever); responseTTL is how long a successful cached response
// is replayed on retry.
func Idempotency(rdb *redis.Client, lockTTL, responseTTL time.Duration) fiber.Handler {
	return func(c *fiber.Ctx) error {
		key := c.Get("Idempotency-Key")
		if key == "" {
			return c.Next()
		}
		userID, _ := c.Locals(LocalsKeyUserID).(string)
		if userID == "" {
			return c.Next()
		}
		cacheKey := "idem:" + userID + ":" + key
		ctx := c.UserContext()

		acquired, err := rdb.SetNX(ctx, cacheKey, idemInFlightSentinel, lockTTL).Result()
		if err != nil {
			log.Warn().Err(err).Str("idempotency_key", key).Msg("idempotency lock acquire failed; proceeding without cache")
			return c.Next()
		}

		if !acquired {
			return idemAwaitOrConflict(c, rdb, cacheKey, key)
		}

		handlerErr := c.Next()
		status := c.Response().StatusCode()
		if handlerErr == nil && status >= 200 && status < 300 {
			payload, marshalErr := json.Marshal(struct {
				Status int             `json:"status"`
				Body   json.RawMessage `json:"body"`
			}{Status: status, Body: c.Response().Body()})
			if marshalErr != nil {
				log.Warn().Err(marshalErr).Str("idempotency_key", key).Msg("idempotency cache marshal failed")
				_ = rdb.Del(ctx, cacheKey).Err()
				return handlerErr
			}
			if setErr := rdb.Set(ctx, cacheKey, payload, responseTTL).Err(); setErr != nil {
				log.Warn().Err(setErr).Str("idempotency_key", key).Msg("idempotency cache write failed")
			}
			return handlerErr
		}

		// Non-2xx or handler error — release the lock so the client can retry.
		if delErr := rdb.Del(ctx, cacheKey).Err(); delErr != nil {
			log.Warn().Err(delErr).Str("idempotency_key", key).Msg("idempotency lock release failed")
		}
		return handlerErr
	}
}

// idemAwaitOrConflict polls a contended idempotency key until either the
// in-flight sentinel is replaced with a real response (replay it) or the
// poll deadline elapses (return 409). Redis errors during polling fail open
// and let the handler run — a transient hiccup mid-poll must not surface as
// a 500 to the client.
func idemAwaitOrConflict(c *fiber.Ctx, rdb *redis.Client, cacheKey, headerKey string) error {
	deadline := time.Now().Add(idemPollDeadline)
	ctx := c.UserContext()
	for {
		val, err := rdb.Get(ctx, cacheKey).Bytes()
		switch {
		case errors.Is(err, redis.Nil):
			// Lock expired before the prior request finished — fall through
			// and run the handler. Treats expiry as no-cache rather than
			// blocking the client further.
			return c.Next()
		case err != nil:
			log.Warn().Err(err).Str("idempotency_key", headerKey).Msg("idempotency poll read failed; proceeding without cache")
			return c.Next()
		case !bytes.Equal(val, idemInFlightSentinel):
			return idemReplayCached(c, val)
		}
		if time.Now().After(deadline) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "duplicate request in flight",
			})
		}
		// Yield with ctx-awareness: if the request deadline fires mid-poll,
		// abandon immediately rather than sleep through the cancellation
		// (audit C-4 / B1-2).
		select {
		case <-time.After(idemPollInterval):
		case <-ctx.Done():
			return c.Next()
		}
	}
}

func idemReplayCached(c *fiber.Ctx, raw []byte) error {
	var stored struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		// Cached value corrupt — proceed to handler.
		return c.Next()
	}
	c.Status(stored.Status)
	c.Set("Content-Type", "application/json")
	c.Set("X-Idempotent-Replay", "true")
	return c.Send(stored.Body)
}
