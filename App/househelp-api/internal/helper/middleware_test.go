package helper

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-backed integration tests for chunk 15 — A1-F3 helper approval
// gate. Skipped when TEST_DATABASE_URL is unset.

func openHelperTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping helper DB-backed tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect db: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// makeHelperWithStatus inserts a users + helpers row pair with the
// given approval_status. Returns the user/helper UUID.
func makeHelperWithStatus(t *testing.T, pool *pgxpool.Pool, status string) string {
	t.Helper()
	id := uuid.NewString()
	phone := "del:c15-" + id[:6]
	_, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'pro')`, id, phone)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	_, err = pool.Exec(context.Background(),
		`INSERT INTO helpers (id, approval_status) VALUES ($1::uuid, $2)`, id, status)
	if err != nil {
		t.Fatalf("insert helper: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1::uuid`, id)
	})
	return id
}

// runRequireApproved fires one request through a Fiber app with
// RequireApproved chained, simulating the auth middleware by
// pre-setting userID in locals. Returns status + decoded body.
func runRequireApproved(t *testing.T, repo *Repository, helperID string) (int, map[string]any) {
	t.Helper()
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals(middleware.LocalsKeyUserID, helperID)
		return c.Next()
	})
	app.Get("/p", RequireApproved(repo), func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"ok": true})
	})
	req := httptest.NewRequest("GET", "/p", nil)
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

func TestGetApprovalStatus_ReturnsPending(t *testing.T) {
	pool := openHelperTestDB(t)
	repo := NewRepository(pool)
	id := makeHelperWithStatus(t, pool, "pending")
	got, err := repo.GetApprovalStatus(context.Background(), id)
	if err != nil {
		t.Fatalf("GetApprovalStatus: %v", err)
	}
	if got != "pending" {
		t.Fatalf("status = %q, want pending", got)
	}
}

func TestGetApprovalStatus_ReturnsApproved(t *testing.T) {
	pool := openHelperTestDB(t)
	repo := NewRepository(pool)
	id := makeHelperWithStatus(t, pool, "approved")
	got, _ := repo.GetApprovalStatus(context.Background(), id)
	if got != "approved" {
		t.Fatalf("status = %q, want approved", got)
	}
}

func TestGetApprovalStatus_ReturnsRejected(t *testing.T) {
	pool := openHelperTestDB(t)
	repo := NewRepository(pool)
	id := makeHelperWithStatus(t, pool, "rejected")
	got, _ := repo.GetApprovalStatus(context.Background(), id)
	if got != "rejected" {
		t.Fatalf("status = %q, want rejected", got)
	}
}

func TestGetApprovalStatus_HelperRowMissing(t *testing.T) {
	pool := openHelperTestDB(t)
	repo := NewRepository(pool)
	_, err := repo.GetApprovalStatus(context.Background(), uuid.NewString())
	if err == nil {
		t.Fatalf("expected error for missing helpers row, got nil")
	}
}

func TestRequireApproved_ApprovedHelperPasses(t *testing.T) {
	pool := openHelperTestDB(t)
	repo := NewRepository(pool)
	id := makeHelperWithStatus(t, pool, "approved")
	status, body := runRequireApproved(t, repo, id)
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	if body["ok"] != true {
		t.Fatalf("approved helper blocked: %v", body)
	}
}

func TestRequireApproved_PendingHelperRejected(t *testing.T) {
	pool := openHelperTestDB(t)
	repo := NewRepository(pool)
	id := makeHelperWithStatus(t, pool, "pending")
	status, body := runRequireApproved(t, repo, id)
	if status != 403 {
		t.Fatalf("status = %d, want 403", status)
	}
	if body["code"] != "HELPER_NOT_APPROVED" {
		t.Errorf("code = %v, want HELPER_NOT_APPROVED", body["code"])
	}
	if body["status"] != "pending" {
		t.Errorf("status field = %v, want pending", body["status"])
	}
}

func TestRequireApproved_RejectedHelperRejected(t *testing.T) {
	pool := openHelperTestDB(t)
	repo := NewRepository(pool)
	id := makeHelperWithStatus(t, pool, "rejected")
	status, body := runRequireApproved(t, repo, id)
	if status != 403 {
		t.Fatalf("status = %d, want 403", status)
	}
	if body["status"] != "rejected" {
		t.Errorf("status field = %v, want rejected", body["status"])
	}
}

func TestRequireApproved_MissingHelperRowRejected(t *testing.T) {
	pool := openHelperTestDB(t)
	repo := NewRepository(pool)
	// userID exists but no helpers row — simulate the data-drift case.
	status, body := runRequireApproved(t, repo, uuid.NewString())
	if status != 403 {
		t.Fatalf("status = %d, want 403", status)
	}
	if body["status"] != "unknown" {
		t.Errorf("status field = %v, want unknown", body["status"])
	}
	if body["code"] != "HELPER_NOT_APPROVED" {
		t.Errorf("code = %v, want HELPER_NOT_APPROVED", body["code"])
	}
}

func TestRequireApproved_InvalidUserIDLocalRejected(t *testing.T) {
	t.Parallel()
	// No DB needed — request never reaches the repo. The middleware
	// must reject before querying when userID is absent / non-string.
	app := fiber.New()
	// Don't set the local.
	app.Get("/p", RequireApproved(nil), func(c *fiber.Ctx) error {
		return c.SendStatus(200)
	})
	req := httptest.NewRequest("GET", "/p", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != 401 {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var decoded map[string]any
	_ = json.Unmarshal(body, &decoded)
	if decoded["code"] != "INVALID_HELPER_ID" {
		t.Errorf("code = %v, want INVALID_HELPER_ID", decoded["code"])
	}
}
