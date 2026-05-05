package middleware

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
)

func newIdemTestRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return mr, rdb
}

func newIdemTestApp(rdb *redis.Client, lockTTL, respTTL time.Duration, handler fiber.Handler) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	// Stand-in for AuthMiddleware: lift X-Test-User header into Locals using
	// the canonical key. Empty header simulates an unauthenticated request.
	app.Use(func(c *fiber.Ctx) error {
		if uid := c.Get("X-Test-User"); uid != "" {
			c.Locals(LocalsKeyUserID, uid)
		}
		return c.Next()
	})
	app.Use(Idempotency(rdb, lockTTL, respTTL))
	app.Post("/", handler)
	return app
}

func idemPost(t *testing.T, app *fiber.App, user, key string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	if user != "" {
		req.Header.Set("X-Test-User", user)
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}
	return resp
}

func readBody(t *testing.T, r *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	_ = r.Body.Close()
	return string(b)
}

func TestIdempotency_CrossUserIsolation(t *testing.T) {
	_, rdb := newIdemTestRedis(t)
	var calls atomic.Int64
	app := newIdemTestApp(rdb, time.Minute, 10*time.Minute, func(c *fiber.Ctx) error {
		n := calls.Add(1)
		uid, _ := c.Locals(LocalsKeyUserID).(string)
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{
			"resp": fmt.Sprintf("user-%s-call-%d", uid, n),
		})
	})

	respA := idemPost(t, app, "userA", "K1")
	if respA.StatusCode != fiber.StatusCreated {
		t.Fatalf("user A first call: status = %d", respA.StatusCode)
	}
	bodyA := readBody(t, respA)
	if !strings.Contains(bodyA, "user-userA-call-1") {
		t.Fatalf("user A body unexpected: %s", bodyA)
	}
	if respA.Header.Get("X-Idempotent-Replay") != "" {
		t.Fatalf("first call must not be a replay")
	}

	respB := idemPost(t, app, "userB", "K1")
	if respB.StatusCode != fiber.StatusCreated {
		t.Fatalf("user B: status = %d", respB.StatusCode)
	}
	bodyB := readBody(t, respB)
	if strings.Contains(bodyB, "userA") {
		t.Fatalf("user B leaked user A response (the bug we just fixed): %s", bodyB)
	}
	if !strings.Contains(bodyB, "user-userB-call-2") {
		t.Fatalf("user B body unexpected: %s", bodyB)
	}
	if respB.Header.Get("X-Idempotent-Replay") != "" {
		t.Fatalf("user B (different namespace) must not be a replay")
	}

	respA2 := idemPost(t, app, "userA", "K1")
	if respA2.StatusCode != fiber.StatusCreated {
		t.Fatalf("user A replay: status = %d", respA2.StatusCode)
	}
	bodyA2 := readBody(t, respA2)
	if bodyA2 != bodyA {
		t.Fatalf("user A replay body mismatch:\n got=%s\nwant=%s", bodyA2, bodyA)
	}
	if respA2.Header.Get("X-Idempotent-Replay") != "true" {
		t.Fatalf("user A replay missing X-Idempotent-Replay header")
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("handler invocations = %d, want 2 (one per user)", got)
	}
}

func TestIdempotency_ConcurrentSameUserSameKey(t *testing.T) {
	_, rdb := newIdemTestRedis(t)
	var calls atomic.Int64
	app := newIdemTestApp(rdb, 5*time.Second, 10*time.Minute, func(c *fiber.Ctx) error {
		calls.Add(1)
		// Hold the lock long enough for the second goroutine to hit the
		// SETNX-loser path and start polling.
		time.Sleep(400 * time.Millisecond)
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"ok": true})
	})

	const N = 2
	var wg sync.WaitGroup
	statuses := make([]int, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := idemPost(t, app, "userA", "K1")
			statuses[i] = r.StatusCode
			_ = readBody(t, r)
		}(i)
	}
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("handler invocations = %d, want exactly 1", got)
	}
	for i, s := range statuses {
		// Acceptable outcomes: 201 (winner ran handler, or loser polled and
		// replayed cached response) OR 409 (loser hit poll deadline).
		if s != fiber.StatusCreated && s != fiber.StatusConflict {
			t.Fatalf("call %d: status = %d, want 201 or 409", i, s)
		}
	}
}

func TestIdempotency_RedisDown(t *testing.T) {
	mr, rdb := newIdemTestRedis(t)
	var calls atomic.Int64
	app := newIdemTestApp(rdb, time.Minute, 10*time.Minute, func(c *fiber.Ctx) error {
		calls.Add(1)
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"ok": true})
	})

	mr.Close()

	resp := idemPost(t, app, "userA", "K1")
	if resp.StatusCode >= 500 {
		t.Fatalf("middleware returned 5xx on Redis down (must fail open): %d", resp.StatusCode)
	}
	if resp.StatusCode != fiber.StatusCreated {
		t.Fatalf("expected 201 (fail-open passthrough), got %d", resp.StatusCode)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("handler not invoked on Redis down: calls=%d", got)
	}
}

func TestIdempotency_EmptyUserID(t *testing.T) {
	mr, rdb := newIdemTestRedis(t)
	var calls atomic.Int64
	app := newIdemTestApp(rdb, time.Minute, 10*time.Minute, func(c *fiber.Ctx) error {
		calls.Add(1)
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"ok": true})
	})

	// No X-Test-User header → no Locals userID → middleware bypasses caching.
	r1 := idemPost(t, app, "", "K1")
	if r1.StatusCode != fiber.StatusCreated {
		t.Fatalf("call 1 status = %d", r1.StatusCode)
	}
	_ = readBody(t, r1)

	r2 := idemPost(t, app, "", "K1")
	if r2.StatusCode != fiber.StatusCreated {
		t.Fatalf("call 2 status = %d", r2.StatusCode)
	}
	_ = readBody(t, r2)

	if got := calls.Load(); got != 2 {
		t.Fatalf("expected 2 handler invocations (no caching for unauth), got %d", got)
	}
	if keys := mr.Keys(); len(keys) != 0 {
		t.Fatalf("expected zero Redis writes for unauth requests, got keys: %v", keys)
	}
}

func TestIdempotency_NonSuccessNotCached(t *testing.T) {
	mr, rdb := newIdemTestRedis(t)
	var calls atomic.Int64
	app := newIdemTestApp(rdb, time.Minute, 10*time.Minute, func(c *fiber.Ctx) error {
		calls.Add(1)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "boom"})
	})

	r1 := idemPost(t, app, "userA", "K1")
	if r1.StatusCode != fiber.StatusInternalServerError {
		t.Fatalf("call 1 status = %d", r1.StatusCode)
	}
	_ = readBody(t, r1)

	cacheKey := "idem:userA:K1"
	if mr.Exists(cacheKey) {
		t.Fatalf("cache key %q must be deleted after non-2xx response", cacheKey)
	}

	r2 := idemPost(t, app, "userA", "K1")
	if r2.StatusCode != fiber.StatusInternalServerError {
		t.Fatalf("call 2 status = %d", r2.StatusCode)
	}
	_ = readBody(t, r2)

	if got := calls.Load(); got != 2 {
		t.Fatalf("expected 2 handler invocations after non-2xx (retryable), got %d", got)
	}
}
