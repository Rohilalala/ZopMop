package capacity

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

// HTTP-layer tests for GET /admin/capacity. Validation (locality/date) and the
// permission gate run before any DB access, so these exercise the handler with
// a nil pool — the repo is never reached on these paths.

func newTestApp(role string) *fiber.App {
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("crmAdminRole", role)
		return c.Next()
	})
	NewHandler(nil).RegisterRoutes(app)
	return app
}

func do(t *testing.T, app *fiber.App, path string) *http.Response {
	t.Helper()
	resp, err := app.Test(httptest.NewRequest(http.MethodGet, path, nil), -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestCapacity_MissingLocality(t *testing.T) {
	resp := do(t, newTestApp("viewer"), "/capacity?date=2026-06-12")
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("missing locality: status = %d, want 400", resp.StatusCode)
	}
}

func TestCapacity_BadDate(t *testing.T) {
	for _, date := range []string{"", "12-06-2026", "2026/06/12", "not-a-date"} {
		resp := do(t, newTestApp("viewer"), "/capacity?locality=Orchid&date="+date)
		if resp.StatusCode != fiber.StatusBadRequest {
			t.Fatalf("date %q: status = %d, want 400", date, resp.StatusCode)
		}
	}
}

func TestCapacity_PermissionDenied(t *testing.T) {
	// An admin with no recognised role cannot read capacity (capacity.read is
	// gated at viewer; an empty role fails the hierarchy check → 403).
	resp := do(t, newTestApp(""), "/capacity?locality=Orchid&date=2026-06-12")
	if resp.StatusCode != fiber.StatusForbidden {
		t.Fatalf("empty role: status = %d, want 403", resp.StatusCode)
	}
}
