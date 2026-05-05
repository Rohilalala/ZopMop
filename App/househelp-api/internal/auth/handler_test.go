package auth

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

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
