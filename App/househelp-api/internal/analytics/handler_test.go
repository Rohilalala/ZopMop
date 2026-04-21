package analytics

import (
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

type trackedEventCall struct {
	eventName  string
	userID     string
	bookingID  string
	properties map[string]interface{}
}

type fakeEventTracker struct {
	mu    sync.Mutex
	calls []trackedEventCall
}

func (f *fakeEventTracker) TrackEvent(_ context.Context, eventName, userID, bookingID string, props map[string]interface{}) {
	f.mu.Lock()
	defer f.mu.Unlock()

	copied := make(map[string]interface{}, len(props))
	for key, value := range props {
		copied[key] = value
	}

	f.calls = append(f.calls, trackedEventCall{
		eventName:  eventName,
		userID:     userID,
		bookingID:  bookingID,
		properties: copied,
	})
}

func (f *fakeEventTracker) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeEventTracker) firstCall(t *testing.T) trackedEventCall {
	t.Helper()

	f.mu.Lock()
	defer f.mu.Unlock()

	if len(f.calls) == 0 {
		t.Fatalf("expected at least one tracked event")
	}

	return f.calls[0]
}

func newTestAnalyticsApp() (*fiber.App, *fakeEventTracker) {
	tracker := &fakeEventTracker{}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", "user-123")
		return c.Next()
	})

	h := NewHandler(&Service{
		writer: tracker,
		dispatch: func(trackFn func()) {
			trackFn()
		},
	})
	h.RegisterClientRoutes(app.Group("/api/v1"))

	return app, tracker
}

func responseBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read response body: %v", err)
	}
	return string(body)
}

func TestTrackClientEventCanonical_MissingRequiredFields_ReturnsBadRequestAndDoesNotTrack(t *testing.T) {
	app, tracker := newTestAnalyticsApp()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(`{"event_name":"app.opened"}`))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d body=%s", resp.StatusCode, responseBody(t, resp))
	}
	if tracker.callCount() != 0 {
		t.Fatalf("expected no tracked events, got %d", tracker.callCount())
	}
}

func TestTrackClientEventCanonical_SensitivePayloadRejected_ReturnsBadRequestAndDoesNotTrack(t *testing.T) {
	app, tracker := newTestAnalyticsApp()

	body := `{
"event_name":"service.viewed",
"event_id":"evt-123",
"event_version":1,
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
		t.Fatalf("expected status 400, got %d body=%s", resp.StatusCode, responseBody(t, resp))
	}
	if tracker.callCount() != 0 {
		t.Fatalf("expected no tracked events, got %d", tracker.callCount())
	}
}

func TestTrackClientEventCanonical_ValidEventAccepted_TracksRoundedPayload(t *testing.T) {
	app, tracker := newTestAnalyticsApp()

	body := `{
"event_name":"service.viewed",
"event_id":"evt-456",
"event_version":2,
"user_id":"user-123",
"helper_id":"helper-99",
"timestamp":"2025-01-01T10:00:00Z",
"device":"ios",
"location":{"lat":28.613912,"lng":77.209023,"area":"Connaught Place"},
"metadata":{"source":"home_feed"},
"properties":{"screen":"home","booking_id":"booking-1"}
}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}

	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("expected status 202, got %d body=%s", resp.StatusCode, responseBody(t, resp))
	}
	if tracker.callCount() != 1 {
		t.Fatalf("expected one tracked event, got %d", tracker.callCount())
	}

	call := tracker.firstCall(t)
	if call.eventName != "service.viewed" {
		t.Fatalf("expected event_name service.viewed, got %s", call.eventName)
	}
	if call.userID != "user-123" {
		t.Fatalf("expected user_id user-123, got %s", call.userID)
	}
	if call.bookingID != "booking-1" {
		t.Fatalf("expected booking_id booking-1, got %s", call.bookingID)
	}

	eventVersion, ok := call.properties["event_version"].(int)
	if !ok || eventVersion != 2 {
		t.Fatalf("expected event_version int(2), got %#v", call.properties["event_version"])
	}

	timestamp, ok := call.properties["timestamp"].(time.Time)
	if !ok {
		t.Fatalf("expected timestamp as time.Time, got %#v", call.properties["timestamp"])
	}
	expectedTime := time.Date(2025, 1, 1, 10, 0, 0, 0, time.UTC)
	if !timestamp.Equal(expectedTime) {
		t.Fatalf("expected timestamp %s, got %s", expectedTime, timestamp)
	}

	lat, ok := call.properties["location_lat"].(float64)
	if !ok || math.Abs(lat-28.614) > 0.000001 {
		t.Fatalf("expected location_lat rounded to 28.614, got %#v", call.properties["location_lat"])
	}
	lng, ok := call.properties["location_lng"].(float64)
	if !ok || math.Abs(lng-77.209) > 0.000001 {
		t.Fatalf("expected location_lng rounded to 77.209, got %#v", call.properties["location_lng"])
	}

	metadata, ok := call.properties["metadata"].(map[string]interface{})
	if !ok || metadata["source"] != "home_feed" {
		t.Fatalf("expected metadata source=home_feed, got %#v", call.properties["metadata"])
	}
	properties, ok := call.properties["properties"].(map[string]interface{})
	if !ok || properties["screen"] != "home" || properties["booking_id"] != "booking-1" {
		t.Fatalf("expected properties screen/home and booking_id/booking-1, got %#v", call.properties["properties"])
	}
}

func TestTrackClientEventCanonical_InvalidTimestampRejected_DoesNotTrack(t *testing.T) {
	app, tracker := newTestAnalyticsApp()

	body := `{
"event_name":"service.viewed",
"event_id":"evt-789",
"event_version":1,
"user_id":"user-123",
"timestamp":"2025/01/01 10:00:00",
"device":"web",
"location":{"lat":28.6139,"lng":77.2090,"area":"Connaught Place"}
}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d body=%s", resp.StatusCode, responseBody(t, resp))
	}
	if tracker.callCount() != 0 {
		t.Fatalf("expected no tracked events, got %d", tracker.callCount())
	}
}

func TestTrackClientEventLegacy_CompatibilityRouteAccepted_TracksEvent(t *testing.T) {
	app, tracker := newTestAnalyticsApp()

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
		t.Fatalf("expected status 202, got %d body=%s", resp.StatusCode, responseBody(t, resp))
	}
	if tracker.callCount() != 1 {
		t.Fatalf("expected one tracked event, got %d", tracker.callCount())
	}

	call := tracker.firstCall(t)
	if call.eventName != "service.viewed" {
		t.Fatalf("expected event_name service.viewed, got %s", call.eventName)
	}
	if call.bookingID != "booking-1" {
		t.Fatalf("expected booking_id booking-1, got %s", call.bookingID)
	}
	if call.properties["screen"] != "home" {
		t.Fatalf("expected property screen=home, got %#v", call.properties["screen"])
	}
}

func TestTrackClientEventLegacy_SensitivePayloadRejected_ReturnsBadRequestAndDoesNotTrack(t *testing.T) {
	app, tracker := newTestAnalyticsApp()

	body := `{
"event_name":"service.viewed",
"booking_id":"booking-1",
"properties":{"token":"secret"}
}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d body=%s", resp.StatusCode, responseBody(t, resp))
	}
	if tracker.callCount() != 0 {
		t.Fatalf("expected no tracked events, got %d", tracker.callCount())
	}
}
