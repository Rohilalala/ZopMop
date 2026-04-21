package booking

import (
	"encoding/json"
	"net/http/httptest"
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
