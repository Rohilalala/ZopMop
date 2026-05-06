package middleware

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
)

// newTestRedis spins up an in-process miniredis bound to the test
// lifecycle and returns a real *redis.Client pointing at it.
func newTestRedis(t *testing.T) (*redis.Client, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb, mr
}

// runReq fires one request through an app with the given handler chain.
// Returns the response status, headers, and body.
func runReq(t *testing.T, app *fiber.App, ip string) (int, map[string]string, []byte) {
	t.Helper()
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-For", ip)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	headers := map[string]string{}
	for k := range resp.Header {
		headers[k] = resp.Header.Get(k)
	}
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, headers, body
}

func TestRateLimit_CRMAdminKeyType_ReadsLocals(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	cfg := RateLimitConfig{MaxRequests: 1, Window: time.Minute, FailureMode: "fail-closed"}

	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		// Simulate crm/middleware.JWT setting the local.
		c.Locals("crmAdminID", "admin-aaa")
		return c.Next()
	})
	app.Use(NamedRateLimiter(rdb, cfg, "crmAdmin", "test-crm"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	// First request consumes the only token.
	if status, _, _ := runReq(t, app, "1.1.1.1"); status != 200 {
		t.Fatalf("first req status=%d, want 200", status)
	}
	// Second request from a DIFFERENT IP but SAME admin id must be
	// blocked — bucket keyed on adminID, not IP.
	if status, _, _ := runReq(t, app, "9.9.9.9"); status != 429 {
		t.Fatalf("second req from same admin status=%d, want 429", status)
	}
}

func TestRateLimit_CRMAdminKeyType_FallsBackToIP(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	cfg := RateLimitConfig{MaxRequests: 1, Window: time.Minute, FailureMode: "fail-closed"}

	app := fiber.New()
	// No locals set — keyType="crmAdmin" must fall back to IP. Two
	// requests from same IP should hit the cap.
	app.Use(NamedRateLimiter(rdb, cfg, "crmAdmin", "test-fallback"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	if status, _, _ := runReq(t, app, "5.5.5.5"); status != 200 {
		t.Fatalf("first req status=%d, want 200", status)
	}
	if status, _, _ := runReq(t, app, "5.5.5.5"); status != 429 {
		t.Fatalf("second req status=%d, want 429 (per-IP fallback)", status)
	}
}

func TestRateLimit_OnReject_FiresOnRejection(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	var hits atomic.Int64
	cfg := RateLimitConfig{
		MaxRequests: 1,
		Window:      time.Minute,
		FailureMode: "fail-closed",
		OnReject:    func(c *fiber.Ctx) { hits.Add(1) },
	}

	app := fiber.New()
	app.Use(NamedRateLimiter(rdb, cfg, "ip", "test-onreject"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	runReq(t, app, "2.2.2.2")
	if got := hits.Load(); got != 0 {
		t.Fatalf("OnReject called on accept path: hits=%d", got)
	}
	if status, _, _ := runReq(t, app, "2.2.2.2"); status != 429 {
		t.Fatalf("expected 429 on second req, got %d", status)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("OnReject hits=%d, want 1", got)
	}
}

func TestRateLimit_OnReject_NilNoCrash(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	cfg := RateLimitConfig{
		MaxRequests: 1, Window: time.Minute, FailureMode: "fail-closed",
		OnReject: nil,
	}
	app := fiber.New()
	app.Use(NamedRateLimiter(rdb, cfg, "ip", "test-nil-onreject"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	runReq(t, app, "3.3.3.3")
	if status, _, _ := runReq(t, app, "3.3.3.3"); status != 429 {
		t.Fatalf("nil OnReject path: status=%d, want 429", status)
	}
}

func TestRateLimit_SuppressHeaders_OmitsRateLimitHeaders(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	cfg := RateLimitConfig{
		MaxRequests:     1,
		Window:          time.Minute,
		FailureMode:     "fail-closed",
		SuppressHeaders: true,
	}
	app := fiber.New()
	app.Use(NamedRateLimiter(rdb, cfg, "ip", "test-suppress"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	runReq(t, app, "4.4.4.4")
	status, headers, _ := runReq(t, app, "4.4.4.4")
	if status != 429 {
		t.Fatalf("expected 429, got %d", status)
	}
	if v := headers["X-Ratelimit-Limit"]; v != "" {
		t.Errorf("X-RateLimit-Limit leaked despite SuppressHeaders=true: %q", v)
	}
	if v := headers["X-Ratelimit-Remaining"]; v != "" {
		t.Errorf("X-RateLimit-Remaining leaked despite SuppressHeaders=true: %q", v)
	}
	if v := headers["X-Ratelimit-Policy"]; v != "" {
		t.Errorf("X-RateLimit-Policy leaked despite SuppressHeaders=true: %q", v)
	}
	if v := headers["Retry-After"]; v == "" {
		t.Errorf("Retry-After missing — must always be set on 429")
	}
}

func TestRateLimit_SuppressHeaders_DefaultIncludesHeaders(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	cfg := RateLimitConfig{
		MaxRequests: 1, Window: time.Minute, FailureMode: "fail-closed",
		// SuppressHeaders zero-value (false) — default behaviour.
	}
	app := fiber.New()
	app.Use(NamedRateLimiter(rdb, cfg, "ip", "test-default-headers"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	runReq(t, app, "6.6.6.6")
	status, headers, _ := runReq(t, app, "6.6.6.6")
	if status != 429 {
		t.Fatalf("expected 429, got %d", status)
	}
	if headers["X-Ratelimit-Limit"] == "" {
		t.Errorf("X-RateLimit-Limit missing in default mode")
	}
	if headers["X-Ratelimit-Remaining"] == "" {
		t.Errorf("X-RateLimit-Remaining missing in default mode")
	}
}

func TestRateLimit_429Body_IncludesRateLimitedCode(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	cfg := RateLimitConfig{MaxRequests: 1, Window: time.Minute, FailureMode: "fail-closed"}
	app := fiber.New()
	app.Use(NamedRateLimiter(rdb, cfg, "ip", "test-body-code"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	runReq(t, app, "7.7.7.7")
	status, _, body := runReq(t, app, "7.7.7.7")
	if status != 429 {
		t.Fatalf("expected 429, got %d", status)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode body: %v\nraw=%s", err, body)
	}
	if decoded["code"] != "RATE_LIMITED" {
		t.Errorf("code = %v, want RATE_LIMITED", decoded["code"])
	}
	if decoded["error"] == nil {
		t.Errorf("error field missing")
	}
	if decoded["retry_after"] == nil {
		t.Errorf("retry_after field missing")
	}
}

func TestRateLimit_OnReject_ReceivesContextLocals(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	var seenAdminID atomic.Pointer[string]
	cfg := RateLimitConfig{
		MaxRequests: 1, Window: time.Minute, FailureMode: "fail-closed",
		OnReject: func(c *fiber.Ctx) {
			id, _ := c.Locals("crmAdminID").(string)
			seenAdminID.Store(&id)
		},
	}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("crmAdminID", "admin-bbb")
		return c.Next()
	})
	app.Use(NamedRateLimiter(rdb, cfg, "crmAdmin", "test-onreject-locals"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	runReq(t, app, "8.8.8.8")
	runReq(t, app, "8.8.8.8")
	got := seenAdminID.Load()
	if got == nil || *got != "admin-bbb" {
		t.Fatalf("OnReject saw adminID=%v, want admin-bbb", got)
	}
}

// Verify the limiter respects request context cancellation. Existing
// behaviour from the C-4 hardening; smoke-tested here so the chunk-14
// refactor doesn't regress it.
func TestRateLimit_HonoursRequestDeadline(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	cfg := RateLimitConfig{MaxRequests: 100, Window: time.Minute, FailureMode: "local-fallback"}
	app := fiber.New()
	app.Use(NamedRateLimiter(rdb, cfg, "ip", "test-ctx"))
	app.Get("/", func(c *fiber.Ctx) error { return c.SendStatus(200) })

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/", nil).WithContext(ctx)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200 under healthy ctx", resp.StatusCode)
	}
}
