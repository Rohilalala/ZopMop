package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// stubChecker is an in-memory SuspensionChecker for unit tests.
type stubChecker struct {
	suspended bool
	err       error
}

func (s stubChecker) IsSuspended(_ context.Context, _ uuid.UUID) (bool, error) {
	return s.suspended, s.err
}

// signTestJWT mints a HS256 JWT with the given claims for AuthMiddleware
// tests. Mirrors the token shape internal/auth/service.go emits.
func signTestJWT(t *testing.T, secret string, claims jwt.MapClaims) string {
	t.Helper()
	if _, ok := claims["exp"]; !ok {
		claims["exp"] = time.Now().Add(time.Hour).Unix()
	}
	if _, ok := claims["iat"]; !ok {
		claims["iat"] = time.Now().Unix()
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tok.Header["kid"] = "test-key"
	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("sign jwt: %v", err)
	}
	return signed
}

// runAuthMiddleware fires one request through an app with AuthMiddleware
// chained, returning status + decoded body.
func runAuthMiddleware(t *testing.T, jwtKeys []JWTKey, checker SuspensionChecker, token string) (int, map[string]any) {
	t.Helper()
	app := fiber.New()
	app.Use(AuthMiddleware(jwtKeys, checker))
	app.Get("/p", func(c *fiber.Ctx) error { return c.JSON(fiber.Map{"ok": true}) })

	req := httptest.NewRequest("GET", "/p", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	var decoded map[string]any
	if len(body) > 0 {
		_ = json.Unmarshal(body, &decoded)
	}
	return resp.StatusCode, decoded
}

func TestAuthMiddleware_NotSuspendedPasses(t *testing.T) {
	t.Parallel()
	const secret = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	keys := []JWTKey{{ID: "test-key", Secret: secret}}
	tok := signTestJWT(t, secret, jwt.MapClaims{
		"user_id":      "11111111-1111-1111-1111-111111111111",
		"role":         "customer",
		"is_suspended": false,
	})
	status, body := runAuthMiddleware(t, keys, stubChecker{suspended: false}, tok)
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	if body["ok"] != true {
		t.Fatalf("not-suspended user blocked: %v", body)
	}
}

func TestAuthMiddleware_SuspendedReturns403(t *testing.T) {
	t.Parallel()
	const secret = "test-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	keys := []JWTKey{{ID: "test-key", Secret: secret}}
	tok := signTestJWT(t, secret, jwt.MapClaims{
		"user_id":      "22222222-2222-2222-2222-222222222222",
		"role":         "customer",
		"is_suspended": false, // claim is stale
	})
	status, body := runAuthMiddleware(t, keys, stubChecker{suspended: true}, tok)
	if status != 403 {
		t.Fatalf("status = %d, want 403", status)
	}
	if body["code"] != "ACCOUNT_SUSPENDED" {
		t.Errorf("code = %v, want ACCOUNT_SUSPENDED", body["code"])
	}
}

func TestAuthMiddleware_CheckerErrorReturns503(t *testing.T) {
	t.Parallel()
	const secret = "test-secret-cccccccccccccccccccccccccccccccccccccccccccccccc"
	keys := []JWTKey{{ID: "test-key", Secret: secret}}
	tok := signTestJWT(t, secret, jwt.MapClaims{
		"user_id":      "33333333-3333-3333-3333-333333333333",
		"role":         "customer",
		"is_suspended": false,
	})
	status, body := runAuthMiddleware(t, keys, stubChecker{err: errors.New("db down")}, tok)
	if status != 503 {
		t.Fatalf("status = %d, want 503 (fail-closed on DB error)", status)
	}
	if body["code"] != "AUTH_CHECK_FAILED" {
		t.Errorf("code = %v, want AUTH_CHECK_FAILED", body["code"])
	}
}

// missingUserChecker mirrors the repo contract: missing users.row →
// (true, nil).
type missingUserChecker struct{}

func (missingUserChecker) IsSuspended(_ context.Context, _ uuid.UUID) (bool, error) {
	return true, nil
}

func TestAuthMiddleware_MissingUserReturns403(t *testing.T) {
	t.Parallel()
	const secret = "test-secret-dddddddddddddddddddddddddddddddddddddddddddddd"
	keys := []JWTKey{{ID: "test-key", Secret: secret}}
	tok := signTestJWT(t, secret, jwt.MapClaims{
		"user_id":      "44444444-4444-4444-4444-444444444444",
		"role":         "customer",
		"is_suspended": false,
	})
	status, body := runAuthMiddleware(t, keys, missingUserChecker{}, tok)
	if status != 403 {
		t.Fatalf("status = %d, want 403", status)
	}
	if body["code"] != "ACCOUNT_SUSPENDED" {
		t.Errorf("code = %v, want ACCOUNT_SUSPENDED", body["code"])
	}
}

// TestAuthMiddleware_NoLongerReadsIsSuspendedFromClaim is THE proof the
// audit A5-06 staleness gap is closed: a JWT with is_suspended=false
// must be blocked when the live DB read returns true. Pre-fix, this
// test would have allowed the request through.
func TestAuthMiddleware_NoLongerReadsIsSuspendedFromClaim(t *testing.T) {
	t.Parallel()
	const secret = "test-secret-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	keys := []JWTKey{{ID: "test-key", Secret: secret}}
	// Token claim says NOT suspended (the stale snapshot).
	tok := signTestJWT(t, secret, jwt.MapClaims{
		"user_id":      "55555555-5555-5555-5555-555555555555",
		"role":         "customer",
		"is_suspended": false,
	})
	// DB says suspended (the live truth).
	status, body := runAuthMiddleware(t, keys, stubChecker{suspended: true}, tok)
	if status != 403 {
		t.Fatalf("status = %d, want 403 — middleware must read DB, not claim", status)
	}
	if body["code"] != "ACCOUNT_SUSPENDED" {
		t.Errorf("code = %v, want ACCOUNT_SUSPENDED", body["code"])
	}
}

func TestAuthMiddleware_NilCheckerFallsBackToJWTClaim(t *testing.T) {
	t.Parallel()
	// Legacy fallback path. Tests / older binaries that haven't wired
	// the checker still have the chunk-1 JWT-claim block as a safety
	// net rather than passing all suspended users through.
	const secret = "test-secret-ffffffffffffffffffffffffffffffffffffffffffffff"
	keys := []JWTKey{{ID: "test-key", Secret: secret}}
	tok := signTestJWT(t, secret, jwt.MapClaims{
		"user_id":      "66666666-6666-6666-6666-666666666666",
		"role":         "customer",
		"is_suspended": true,
	})
	status, body := runAuthMiddleware(t, keys, nil, tok)
	if status != 403 {
		t.Fatalf("status = %d, want 403 (legacy claim path)", status)
	}
	if body["code"] != "ACCOUNT_SUSPENDED" {
		t.Errorf("code = %v, want ACCOUNT_SUSPENDED", body["code"])
	}
}
