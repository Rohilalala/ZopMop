package booking

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestGetTracking_InvalidBookingID_ReturnsBadRequest(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	h := NewHandler(nil)
	app.Get("/bookings/:id/tracking", h.GetTracking)

	req := httptest.NewRequest("GET", "/bookings/not-a-uuid/tracking", nil)

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
	if body["error"] != "invalid booking id" {
		t.Fatalf("expected error %q, got %q", "invalid booking id", body["error"])
	}
}

// TestCreateInstantBooking_RouteRegistered confirms POST /bookings/instant is
// mounted (FE createInstantCartBooking targets it) and gated by auth: with no
// userID local the handler must short-circuit to 401 before touching the service,
// so NewHandler(nil) is safe here.
func TestCreateInstantBooking_RouteRegistered(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	h := NewHandler(nil)
	h.RegisterRoutes(app.Group("/bookings"), nil, nil, nil)

	req := httptest.NewRequest("POST", "/bookings/instant", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	// 404 would mean the route is unregistered. Auth gate returns 401.
	if resp.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("expected status %d (route present, auth-gated), got %d", fiber.StatusUnauthorized, resp.StatusCode)
	}
}

// TestCreateInstantBooking_InvalidBody_ReturnsBadRequest verifies the handler
// validates address_id before reaching the service (empty body → 400), so
// NewHandler(nil) is safe.
func TestCreateInstantBooking_InvalidBody_ReturnsBadRequest(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	h := NewHandler(nil)
	// Inject a userID local so the handler clears the auth gate and reaches body
	// validation.
	app.Post("/bookings/instant", func(c *fiber.Ctx) error {
		c.Locals("userID", "11111111-1111-1111-1111-111111111111")
		return h.CreateInstantBooking(c)
	})

	req := httptest.NewRequest("POST", "/bookings/instant", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", fiber.StatusBadRequest, resp.StatusCode)
	}

	var body map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("failed decoding response body: %v", err)
	}
	if body["error"] != "validation failed" {
		t.Fatalf("expected error %q, got %v", "validation failed", body["error"])
	}
}
