package middleware

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// RateLimitConfig defines rate limit parameters.
type RateLimitConfig struct {
	MaxRequests int
	Window      time.Duration
	FailureMode string
}

var (
	// PublicRateLimit: 30 req/min by IP.
	PublicRateLimit = RateLimitConfig{MaxRequests: 30, Window: time.Minute, FailureMode: "local-fallback"}
	// SensitivePublicRateLimit: 20 req/min by IP, fail-closed (e.g. OTP/auth endpoints).
	SensitivePublicRateLimit = RateLimitConfig{MaxRequests: 20, Window: time.Minute, FailureMode: "fail-closed"}
	// AuthRateLimit: 100 req/min by userID.
	AuthRateLimit = RateLimitConfig{MaxRequests: 100, Window: time.Minute, FailureMode: "fail-closed"}
	// AdminRateLimit: 200 req/min by userID.
	AdminRateLimit = RateLimitConfig{MaxRequests: 200, Window: time.Minute, FailureMode: "fail-closed"}
)

var (
	localLimiterMu      sync.Mutex
	localLimiterBuckets = map[string]*localCounter{}

	rateLimiterRedisFailures       atomic.Int64
	rateLimiterFailClosedRejects   atomic.Int64
	rateLimiterLocalFallbackAllows atomic.Int64
	rateLimiterLocalFallbackReject atomic.Int64
)

type localCounter struct {
	windowStart int64
	count       int
}

func allowWithLocalFallback(key string, config RateLimitConfig, now time.Time) (allowed bool, remaining int, retryAfter int) {
	windowSeconds := int(config.Window.Seconds())
	if windowSeconds <= 0 {
		windowSeconds = 60
	}
	windowStart := now.Unix() / int64(windowSeconds)

	localLimiterMu.Lock()
	defer localLimiterMu.Unlock()

	// Opportunistic cleanup to keep memory bounded.
	if len(localLimiterBuckets) > 10000 {
		cutoff := windowStart - 2
		for k, v := range localLimiterBuckets {
			if v.windowStart < cutoff {
				delete(localLimiterBuckets, k)
			}
		}
	}

	bucket, ok := localLimiterBuckets[key]
	if !ok || bucket.windowStart != windowStart {
		bucket = &localCounter{windowStart: windowStart, count: 0}
		localLimiterBuckets[key] = bucket
	}

	if bucket.count >= config.MaxRequests {
		retryAfter = windowSeconds - (int(now.Unix()) % windowSeconds)
		if retryAfter <= 0 {
			retryAfter = windowSeconds
		}
		return false, 0, retryAfter
	}

	bucket.count++
	remaining = config.MaxRequests - bucket.count
	return true, remaining, 0
}

// RateLimiterMetrics exposes limiter health counters for observability endpoints.
func RateLimiterMetrics() map[string]int64 {
	return map[string]int64{
		"redis_failures_total":         rateLimiterRedisFailures.Load(),
		"fail_closed_rejections_total": rateLimiterFailClosedRejects.Load(),
		"local_fallback_allows_total":  rateLimiterLocalFallbackAllows.Load(),
		"local_fallback_rejects_total": rateLimiterLocalFallbackReject.Load(),
	}
}

// RateLimiter returns a Fiber middleware that enforces a sliding window
// rate limit using Redis. keyPrefix is used to distinguish limit buckets.
func RateLimiter(rdb *redis.Client, config RateLimitConfig, keyType string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var identifier string

		switch keyType {
		case "ip":
			identifier = c.IP()
		case "user":
			if userID, ok := c.Locals("userID").(string); ok && userID != "" {
				identifier = userID
			} else {
				identifier = c.IP()
			}
		default:
			identifier = c.IP()
		}

		key := fmt.Sprintf("ratelimit:%s:%s", keyType, identifier)
		ctx := context.Background()
		now := time.Now()
		windowStart := now.Add(-config.Window).UnixMilli()
		nowMilli := now.UnixMilli()

		// Use Lua script for atomic sliding window counter.
		// ZADD + ZREMRANGEBYSCORE + ZCARD in one atomic operation.
		script := redis.NewScript(`
			local key = KEYS[1]
			local now_milli = tonumber(ARGV[1])
			local window_start = tonumber(ARGV[2])
			local max_requests = tonumber(ARGV[3])
			local window_ms = tonumber(ARGV[4])

			-- Remove expired entries
			redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

			-- Count current entries in window
			local count = redis.call('ZCARD', key)

			-- If under limit, add new entry and allow request
			if count < max_requests then
				redis.call('ZADD', key, now_milli, now_milli .. ':' .. math.random())
				redis.call('EXPIRE', key, window_ms)
				return {1, max_requests - count - 1}
			else
				return {0, 0}
			end
		`)

		result, err := script.Run(ctx, rdb, []string{key}, nowMilli, windowStart, config.MaxRequests, int(config.Window.Seconds())).Slice()
		if err != nil {
			rateLimiterRedisFailures.Add(1)
			log.Error().Err(err).Str("key", key).Msg("rate limiter script failed")

			switch config.FailureMode {
			case "fail-closed":
				rateLimiterFailClosedRejects.Add(1)
				c.Set("X-RateLimit-Limit", strconv.Itoa(config.MaxRequests))
				c.Set("X-RateLimit-Remaining", "0")
				c.Set("Retry-After", strconv.Itoa(int(config.Window.Seconds())))
				return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
					"error":       "rate limiter unavailable",
					"retry_after": int(config.Window.Seconds()),
				})
			case "local-fallback":
				allowed, remaining, retryAfter := allowWithLocalFallback(key, config, now)
				c.Set("X-RateLimit-Limit", strconv.Itoa(config.MaxRequests))
				c.Set("X-RateLimit-Remaining", strconv.Itoa(max(0, remaining)))
				c.Set("X-RateLimit-Policy", "local-fallback")
				if !allowed {
					rateLimiterLocalFallbackReject.Add(1)
					c.Set("Retry-After", strconv.Itoa(retryAfter))
					return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
						"error":       "rate limit exceeded",
						"retry_after": retryAfter,
					})
				}
				rateLimiterLocalFallbackAllows.Add(1)
				return c.Next()
			default:
				// Legacy fallback behavior.
				return c.Next()
			}
		}

		allowed := result[0].(int64)
		remaining := result[1].(int64)

		// Set rate limit headers.
		c.Set("X-RateLimit-Limit", strconv.Itoa(config.MaxRequests))
		c.Set("X-RateLimit-Remaining", strconv.Itoa(max(0, int(remaining))))

		if allowed == 0 {
			// Get oldest entry timestamp to calculate retry-after.
			oldest, err := rdb.ZRangeWithScores(ctx, key, 0, 0).Result()
			if err != nil || len(oldest) == 0 {
				c.Set("Retry-After", strconv.Itoa(int(config.Window.Seconds())))
				return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
					"error":       "rate limit exceeded",
					"retry_after": int(config.Window.Seconds()),
				})
			}
			retryAfter := int(oldest[0].Score) + int(config.Window.Seconds()*1000) - int(nowMilli)
			if retryAfter < 0 {
				retryAfter = int(config.Window.Seconds())
			}
			c.Set("Retry-After", strconv.Itoa(retryAfter/1000))
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
				"error":       "rate limit exceeded",
				"retry_after": retryAfter / 1000,
			})
		}

		return c.Next()
	}
}
