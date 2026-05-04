package middleware

import (
	"context"
	"fmt"
	"os"
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
	// PublicRateLimit: 30 req/min by IP. Bumped to 10000 in development so
	// loopback bench traffic from a single source IP is not bottlenecked by
	// the limiter (production value is unchanged — see init below).
	PublicRateLimit = RateLimitConfig{MaxRequests: 30, Window: time.Minute, FailureMode: "local-fallback"}
	// SensitivePublicRateLimit: 20 req/min by IP, fail-closed (e.g. OTP/auth endpoints).
	SensitivePublicRateLimit = RateLimitConfig{MaxRequests: 20, Window: time.Minute, FailureMode: "fail-closed"}
	// AuthRateLimit: 100 req/min by userID.
	AuthRateLimit = RateLimitConfig{MaxRequests: 100, Window: time.Minute, FailureMode: "fail-closed"}
	// AdminRateLimit: 200 req/min by userID.
	AdminRateLimit = RateLimitConfig{MaxRequests: 200, Window: time.Minute, FailureMode: "fail-closed"}
	// BookingCreateRateLimit caps booking creation per authenticated user to
	// 3 requests per minute. Tighter than AuthRateLimit because each booking
	// kicks off matching, notifications, and DB write fan-out — accidental or
	// abusive bursts are far more expensive than a typical authenticated GET.
	// Falls back to local in-memory limiter if Redis is down so a Redis blip
	// cannot enable a flood (still bounded by the global authLimiter at 100/min).
	BookingCreateRateLimit = RateLimitConfig{MaxRequests: 3, Window: time.Minute, FailureMode: "local-fallback"}
)

// init relaxes PublicRateLimit when running in development. APP_ENV takes
// precedence over the legacy ENV variable, matching pkg/config's resolution
// order. Production values are never modified — the env check is the gate.
func init() {
	env := os.Getenv("APP_ENV")
	if env == "" {
		env = os.Getenv("ENV")
	}
	if env == "development" {
		PublicRateLimit.MaxRequests = 10000
	}
}

// tokenBucket implements a per-key in-process pre-filter for the Redis
// sliding-window limiter. Capacity == MaxRequests, refilling at MaxRequests
// per Window. When a key is in steady overage (e.g. a single IP flooding the
// loopback during a bench), the bucket drains and subsequent calls return
// false without touching Redis. The Redis Lua script remains the source of
// truth — local pre-check is intentionally permissive (bursty), so it acts
// only as a load shield, never a stricter gate.
type tokenBucket struct {
	mu         sync.Mutex
	tokens     float64
	lastRefill time.Time
}

func (b *tokenBucket) tryConsume(now time.Time, capacity, refillPerSec float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.lastRefill.IsZero() {
		elapsed := now.Sub(b.lastRefill).Seconds()
		if elapsed > 0 {
			b.tokens += elapsed * refillPerSec
			if b.tokens > capacity {
				b.tokens = capacity
			}
		}
	} else {
		// First touch — start full so a single visitor gets the documented
		// burst headroom rather than being capped to the refill rate.
		b.tokens = capacity
	}
	b.lastRefill = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

var (
	localBucketsMu sync.RWMutex
	localBuckets   = map[string]*tokenBucket{}

	rateLimiterLocalSkipsRedis atomic.Int64
)

// getLocalBucket returns the per-key bucket, creating it on demand. Cold
// buckets are reaped opportunistically when the map grows past 50k entries
// (one entry ≈ 64 B; 50k caps the limiter map at ~3 MiB).
func getLocalBucket(key string) *tokenBucket {
	localBucketsMu.RLock()
	b, ok := localBuckets[key]
	localBucketsMu.RUnlock()
	if ok {
		return b
	}
	localBucketsMu.Lock()
	defer localBucketsMu.Unlock()
	if b, ok = localBuckets[key]; ok {
		return b
	}
	if len(localBuckets) > 50000 {
		cutoff := time.Now().Add(-5 * time.Minute)
		for k, v := range localBuckets {
			v.mu.Lock()
			cold := v.lastRefill.Before(cutoff)
			v.mu.Unlock()
			if cold {
				delete(localBuckets, k)
			}
		}
	}
	b = &tokenBucket{}
	localBuckets[key] = b
	return b
}

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
		"local_prefilter_skips_total":  rateLimiterLocalSkipsRedis.Load(),
	}
}

// RateLimiter returns a Fiber middleware that enforces a sliding window
// rate limit using Redis. keyType ("ip" or "user") selects the identifier.
// Buckets are namespaced as ratelimit:<keyType>:<identifier> — callers that
// need a separate bucket on the same identifier (e.g. a route-specific cap
// chained with the global per-user cap) should use NamedRateLimiter.
func RateLimiter(rdb *redis.Client, config RateLimitConfig, keyType string) fiber.Handler {
	return NamedRateLimiter(rdb, config, keyType, "")
}

// NamedRateLimiter is RateLimiter with an extra bucket namespace so multiple
// limiters keyed off the same identifier (e.g. userID) can be chained without
// sharing counters. Pass bucket="" to behave identically to RateLimiter.
func NamedRateLimiter(rdb *redis.Client, config RateLimitConfig, keyType, bucket string) fiber.Handler {
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

		var key string
		if bucket != "" {
			key = fmt.Sprintf("ratelimit:%s:%s:%s", bucket, keyType, identifier)
		} else {
			key = fmt.Sprintf("ratelimit:%s:%s", keyType, identifier)
		}
		ctx := context.Background()
		now := time.Now()
		windowStart := now.Add(-config.Window).UnixMilli()
		nowMilli := now.UnixMilli()

		// In-process pre-check: skip the Redis round-trip for keys already in
		// steady overage. Local bucket holds capacity = MaxRequests and refills
		// at MaxRequests / Window per second; a sustained-overload caller
		// drains it within one window and never reaches Redis until they slow
		// down. Local denies always 429 — Redis remains the authoritative
		// allow path so distributed accuracy isn't sacrificed.
		windowSecs := config.Window.Seconds()
		if windowSecs > 0 {
			capacity := float64(config.MaxRequests)
			refill := capacity / windowSecs
			if !getLocalBucket(key).tryConsume(now, capacity, refill) {
				rateLimiterLocalSkipsRedis.Add(1)
				retryAfter := int(windowSecs)
				c.Set("X-RateLimit-Limit", strconv.Itoa(config.MaxRequests))
				c.Set("X-RateLimit-Remaining", "0")
				c.Set("X-RateLimit-Policy", "local-prefilter")
				c.Set("Retry-After", strconv.Itoa(retryAfter))
				return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
					"error":       "rate limit exceeded",
					"retry_after": retryAfter,
				})
			}
		}

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
			// Warn (not error) — Redis being unreachable is a degraded condition
			// handled below per FailureMode, not an aborted request.
			log.Warn().Err(err).Str("key", key).Msg("rate limiter script failed; entering degraded mode")

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
