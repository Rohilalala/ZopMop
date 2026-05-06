package auth

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
)

// TestRegisterMeRoutes_PanicsWithoutCompliance asserts that mounting
// /me without wiring compliance.Service is a startup failure rather
// than a silent runtime degradation. Catches the deploy mistake of
// forgetting to call SetCompliance before RegisterMeRoutes — DPDP §11
// data portability is a compliance feature, fail-loud > fail-quiet.
func TestRegisterMeRoutes_PanicsWithoutCompliance(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("expected panic when compliance.Service not wired")
		}
	}()
	h := NewHandler(nil, nil, false)
	h.RegisterMeRoutes(fiber.New())
}

// TestSetCompliance_PanicsOnNil asserts the setter itself rejects nil
// rather than silently accepting it (which would resurface later as a
// nil-deref deep inside ExportMe).
func TestSetCompliance_PanicsOnNil(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("expected panic on SetCompliance(nil)")
		}
	}()
	h := NewHandler(nil, nil, false)
	h.SetCompliance(nil)
}

// TestExportMe_RateLimitFailsClosedOnRedisDown asserts that when Redis
// is unreachable, the handler refuses service (503) rather than
// proceeding with an unbounded export. Each export is ~18 DB queries —
// silent fail-open during a Redis outage is a DoS vector.
func TestExportMe_RateLimitFailsClosedOnRedisDown(t *testing.T) {
	t.Parallel()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	h := NewHandler(nil, rdb, false)

	app := fiber.New()
	app.Get("/me/export", func(c *fiber.Ctx) error {
		c.Locals("userID", "11111111-1111-1111-1111-111111111111")
		return h.ExportMe(c)
	})

	// Kill miniredis to simulate outage. Subsequent SETNX errors out.
	mr.Close()

	req := httptest.NewRequest("GET", "/me/export", nil)
	resp, err := app.Test(req, int(2*time.Second/time.Millisecond))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if resp.StatusCode != fiber.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (fail-closed)", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["code"] != "RATE_LIMIT_UNAVAILABLE" {
		t.Fatalf("code = %q, want RATE_LIMIT_UNAVAILABLE", body["code"])
	}
}

func TestSendOTP_InvalidJSON_ReturnsBadRequest(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	h := NewHandler(nil, nil, false)
	app.Post("/auth/send-otp", h.SendOTP)

	req := httptest.NewRequest("POST", "/auth/send-otp", strings.NewReader("{"))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", fiber.StatusBadRequest, resp.StatusCode)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("failed decoding response body: %v", err)
	}
	if body["error"] != "invalid request body" {
		t.Fatalf("expected error %q, got %q", "invalid request body", body["error"])
	}
}

func TestMapSendOTPError_SanitizesUnexpectedError(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		return mapSendOTPError(c, errors.New("redis dial tcp 10.0.0.1:6379: timeout"))
	})

	req := httptest.NewRequest("GET", "/", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if resp.StatusCode != fiber.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", fiber.StatusInternalServerError, resp.StatusCode)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("failed decoding response body: %v", err)
	}
	if body["error"] != "failed to send OTP" {
		t.Fatalf("expected sanitized error, got %q", body["error"])
	}
}

func TestMapVerifyOTPError_HandlesExpectedAndUnexpectedErrors(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	app.Get("/known", func(c *fiber.Ctx) error {
		return mapVerifyOTPError(c, ErrInvalidOTP)
	})
	app.Get("/unknown", func(c *fiber.Ctx) error {
		return mapVerifyOTPError(c, errors.New("failed to retrieve OTP: dial tcp 10.0.0.1:6379: timeout"))
	})

	knownReq := httptest.NewRequest("GET", "/known", nil)
	knownResp, err := app.Test(knownReq)
	if err != nil {
		t.Fatalf("known request failed: %v", err)
	}
	if knownResp.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("expected known status %d, got %d", fiber.StatusUnauthorized, knownResp.StatusCode)
	}
	var knownBody map[string]string
	if err := json.NewDecoder(knownResp.Body).Decode(&knownBody); err != nil {
		t.Fatalf("failed decoding known response body: %v", err)
	}
	if knownBody["error"] != ErrInvalidOTP.Error() {
		t.Fatalf("expected known error %q, got %q", ErrInvalidOTP.Error(), knownBody["error"])
	}

	unknownReq := httptest.NewRequest("GET", "/unknown", nil)
	unknownResp, err := app.Test(unknownReq)
	if err != nil {
		t.Fatalf("unknown request failed: %v", err)
	}
	if unknownResp.StatusCode != fiber.StatusInternalServerError {
		t.Fatalf("expected unknown status %d, got %d", fiber.StatusInternalServerError, unknownResp.StatusCode)
	}
	var unknownBody map[string]string
	if err := json.NewDecoder(unknownResp.Body).Decode(&unknownBody); err != nil {
		t.Fatalf("failed decoding unknown response body: %v", err)
	}
	if unknownBody["error"] != "failed to verify OTP" {
		t.Fatalf("expected sanitized unknown error, got %q", unknownBody["error"])
	}
}

func TestMapVerifyFirebaseError_SanitizesUnexpectedError(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	app.Get("/known", func(c *fiber.Ctx) error {
		return mapVerifyFirebaseError(c, ErrInvalidFirebaseToken)
	})
	app.Get("/unknown", func(c *fiber.Ctx) error {
		return mapVerifyFirebaseError(c, errors.New("firebase init failed: open /secrets/key.json: no such file"))
	})

	knownReq := httptest.NewRequest("GET", "/known", nil)
	knownResp, err := app.Test(knownReq)
	if err != nil {
		t.Fatalf("known request failed: %v", err)
	}
	if knownResp.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("expected known status %d, got %d", fiber.StatusUnauthorized, knownResp.StatusCode)
	}
	var knownBody map[string]string
	if err := json.NewDecoder(knownResp.Body).Decode(&knownBody); err != nil {
		t.Fatalf("failed decoding known response body: %v", err)
	}
	if knownBody["error"] != "invalid firebase token" {
		t.Fatalf("expected known firebase error, got %q", knownBody["error"])
	}

	unknownReq := httptest.NewRequest("GET", "/unknown", nil)
	unknownResp, err := app.Test(unknownReq)
	if err != nil {
		t.Fatalf("unknown request failed: %v", err)
	}
	if unknownResp.StatusCode != fiber.StatusInternalServerError {
		t.Fatalf("expected unknown status %d, got %d", fiber.StatusInternalServerError, unknownResp.StatusCode)
	}
	var unknownBody map[string]string
	if err := json.NewDecoder(unknownResp.Body).Decode(&unknownBody); err != nil {
		t.Fatalf("failed decoding unknown response body: %v", err)
	}
	if unknownBody["error"] != "failed to verify firebase token" {
		t.Fatalf("expected sanitized unknown firebase error, got %q", unknownBody["error"])
	}
}
