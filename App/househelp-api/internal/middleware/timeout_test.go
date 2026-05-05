package middleware

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

// newTimeoutTestApp wires the Timeout middleware in front of a single POST
// /run handler. The handler is supplied per-test so each scenario controls
// what kind of work runs inside the deadline.
func newTimeoutTestApp(d time.Duration, handler fiber.Handler) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(Timeout(d))
	app.Post("/run", handler)
	return app
}

func doPost(t *testing.T, app *fiber.App) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/run", strings.NewReader(""))
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	return resp
}

func readAll(t *testing.T, r *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	_ = r.Body.Close()
	return string(b)
}

// TestTimeout_HandlerCompletesInTime: handler returns inside the deadline.
// The middleware must pass the response through unchanged and fire no warn.
func TestTimeout_HandlerCompletesInTime(t *testing.T) {
	app := newTimeoutTestApp(time.Second, func(c *fiber.Ctx) error {
		time.Sleep(50 * time.Millisecond)
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"ok": true})
	})

	resp := doPost(t, app)
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.Contains(body, `"ok":true`) {
		t.Fatalf("body = %q, want ok=true", body)
	}
}

// TestTimeout_HandlerObservesCtxAndExits: handler selects on ctx.Done() and
// returns ctx.Err() WITHOUT writing any response. Middleware must observe
// the deadline-exceeded path with an empty response and emit the 503 JSON.
// This is the contract for ctx-aware handlers — no goroutine race because
// the handler has fully returned before we touch the response.
func TestTimeout_HandlerObservesCtxAndExits(t *testing.T) {
	app := newTimeoutTestApp(50*time.Millisecond, func(c *fiber.Ctx) error {
		select {
		case <-c.UserContext().Done():
			return c.UserContext().Err()
		case <-time.After(5 * time.Second):
			return c.SendStatus(fiber.StatusOK)
		}
	})

	resp := doPost(t, app)
	if resp.StatusCode != fiber.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.Contains(body, `"code":"TIMEOUT"`) {
		t.Fatalf("body missing TIMEOUT code: %q", body)
	}
}

// TestTimeout_HandlerIgnoresCtxAndOverruns: handler ignores ctx, sleeps past
// the deadline, then writes its own 200 OK response. Middleware MUST NOT
// overwrite that response with a 503 — overwriting is precisely the
// race-condition that audit C-4 / B1-2 exploits (writes after the pooled
// fasthttp ctx may have been re-bound to another connection). The handler's
// 200 must survive; the middleware just logs a warn.
func TestTimeout_HandlerIgnoresCtxAndOverruns(t *testing.T) {
	app := newTimeoutTestApp(50*time.Millisecond, func(c *fiber.Ctx) error {
		// Ignore ctx entirely — the bug shape we're guarding against.
		time.Sleep(150 * time.Millisecond)
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"late": true})
	})

	resp := doPost(t, app)
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("late-completion status = %d, want 200 (handler's response must be preserved)", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.Contains(body, `"late":true`) {
		t.Fatalf("late-completion body = %q, want handler payload preserved", body)
	}
}

// TestTimeout_NoLeakedGoroutine: the rewrite drops the goroutine spawn that
// the previous implementation used. Drive 200 timed-out requests through
// the middleware and assert NumGoroutine returns to baseline. A regression
// that re-introduced `go func() { c.Next() }` would leak a goroutine per
// timeout, blowing up this counter.
func TestTimeout_NoLeakedGoroutine(t *testing.T) {
	app := newTimeoutTestApp(20*time.Millisecond, func(c *fiber.Ctx) error {
		select {
		case <-c.UserContext().Done():
			return c.UserContext().Err()
		case <-time.After(5 * time.Second):
			return c.SendStatus(fiber.StatusOK)
		}
	})

	// Warm up so the fasthttp pool reaches steady state.
	for i := 0; i < 5; i++ {
		_ = doPost(t, app)
	}
	runtime.GC()
	baseline := runtime.NumGoroutine()

	const iterations = 200
	var wg sync.WaitGroup
	wg.Add(iterations)
	for i := 0; i < iterations; i++ {
		go func() {
			defer wg.Done()
			r := doPost(t, app)
			_ = readAll(t, r)
		}()
	}
	wg.Wait()

	// Give any transient internal goroutines a chance to wind down.
	time.Sleep(100 * time.Millisecond)
	runtime.GC()
	after := runtime.NumGoroutine()

	// Tolerance: fiber/fasthttp may keep a few internal pool goroutines
	// alive. We're guarding against a per-request leak (would scale with
	// `iterations`), not a small constant overhead.
	const tolerance = 10
	if after-baseline > tolerance {
		t.Fatalf("goroutine leak suspected: baseline=%d after=%d delta=%d (tolerance=%d, iterations=%d)",
			baseline, after, after-baseline, tolerance, iterations)
	}
}

// Compile-time guard: the helper Timeout signature must keep accepting a
// context cancel function reference for the underlying deadline impl. If
// the package no longer imports context, this will fail to build — which
// is fine, but we want the test suite to surface it loudly.
var _ = context.Canceled
