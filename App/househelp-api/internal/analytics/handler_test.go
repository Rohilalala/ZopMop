package analytics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func newTestAnalyticsApp() *fiber.App {
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", "user-123")
		return c.Next()
	})

	h := NewHandler(&Service{})
	h.RegisterClientRoutes(app.Group("/api/v1"))

	return app
}

func TestTrackClientEventCanonical_MissingRequiredFields_ReturnsBadRequest(t *testing.T) {
	app := newTestAnalyticsApp()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(`{"event_name":"app.opened"}`))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", resp.StatusCode)
	}
}

func TestTrackClientEventCanonical_SensitivePayloadRejected_ReturnsBadRequest(t *testing.T) {
	app := newTestAnalyticsApp()

	body := `{
"event_name":"service.viewed",
"event_id":"evt-123",
"event_version":"1.0",
"user_id":"user-123",
"helper_id":"helper-99",
"timestamp":"2025-01-01T10:00:00Z",
"device":"android",
"location":{"lat":28.6139,"lng":77.2090,"area":"Connaught Place"},
"metadata":{"token":"secret"},
"properties":{"screen":"home"}
}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", resp.StatusCode)
	}
}

func TestTrackClientEventCanonical_ValidEventAccepted_ReturnsAccepted(t *testing.T) {
	app := newTestAnalyticsApp()

	body := `{
"event_name":"service.viewed",
"event_id":"evt-456",
"event_version":"1.0",
"user_id":"user-123",
"helper_id":"helper-99",
"timestamp":"2025-01-01T10:00:00Z",
"device":"ios",
"location":{"lat":28.6139,"lng":77.2090,"area":"Connaught Place"},
"metadata":{"source":"home_feed"},
"properties":{"screen":"home"}
}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("expected status 202, got %d", resp.StatusCode)
	}
}

func TestTrackClientEventLegacy_CompatibilityRouteAccepted(t *testing.T) {
	app := newTestAnalyticsApp()

	body := `{
		"event_name":"service.viewed",
		"booking_id":"booking-1",
		"properties":{"screen":"home"}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("expected status 202, got %d", resp.StatusCode)
	}
}
