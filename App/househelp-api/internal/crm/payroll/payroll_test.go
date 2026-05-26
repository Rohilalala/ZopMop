package payroll_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	crmpayroll "github.com/adityarohilla/househelp-api/internal/crm/payroll"
	payengine "github.com/adityarohilla/househelp-api/internal/payroll"
)

// All tests skip when no DB is reachable from the test host.

func dsn() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://househelp:localdev123@localhost:5432/househelp_db"
}

type fixture struct {
	pool     *pgxpool.Pool
	proID    string
	adminID  string
	payoutID string
	cycle    payengine.CycleClose
	app      *fiber.App
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn())
	if err != nil {
		t.Skipf("no DB: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("DB ping failed: %v", err)
	}

	loc := payengine.Location()
	cycle := payengine.CycleClose{
		Start: time.Date(2026, time.May, 1, 0, 0, 0, 0, loc),
		End:   time.Date(2026, time.May, 15, 0, 0, 0, 0, loc),
	}

	proID := uuid.NewString()
	phone := "+91-pp-" + uuid.NewString()[:8]
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, phone, name, role) VALUES ($1::uuid, $2, 'PayrollCRMTest', 'pro')`,
		proID, phone,
	); err != nil {
		pool.Close()
		t.Fatalf("seed user: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO helpers (id, effective_start_date) VALUES ($1::uuid, '2026-01-01')`,
		proID,
	); err != nil {
		pool.Close()
		t.Fatalf("seed helper: %v", err)
	}

	adminID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO crm_admins (id, email, password_hash, display_name, role)
		VALUES ($1::uuid, $2, 'x', 'PayrollTest', 'admin')
	`, adminID, "pp-"+uuid.NewString()[:8]+"@test.local"); err != nil {
		pool.Close()
		t.Fatalf("seed crm_admin: %v", err)
	}

	var payoutID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO payouts (
			pro_id, cycle_start, cycle_end,
			online_minutes, working_minutes,
			base_pay_paise, work_bonus_paise, gross_pay_paise,
			net_pay_paise, status
		) VALUES (
			$1::uuid, '2026-05-01', '2026-05-15',
			0, 0, 0, 0, 0, 0, 'pending_manual_payout'
		)
		RETURNING id::text
	`, proID).Scan(&payoutID); err != nil {
		pool.Close()
		t.Fatalf("seed payout: %v", err)
	}

	repo := crmpayroll.NewRepository(pool, pool)
	engineRepo := payengine.NewRepository(pool)
	engineSvc := payengine.NewService(engineRepo)
	h := crmpayroll.NewHandler(repo, engineSvc, nil)

	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("crmAdminID", adminID)
		c.Locals("crmAdminEmail", "test@test.local")
		c.Locals("crmAdminRole", "admin")
		return c.Next()
	})
	h.RegisterRoutes(app)

	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM payout_audit_log WHERE payout_id IN (SELECT id FROM payouts WHERE pro_id = $1::uuid)`, proID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM payouts WHERE pro_id = $1::uuid`, proID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM helpers WHERE id = $1::uuid`, proID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1::uuid`, proID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM crm_admins WHERE id = $1::uuid`, adminID)
		pool.Close()
	})

	return &fixture{
		pool: pool, proID: proID, adminID: adminID, payoutID: payoutID,
		cycle: cycle, app: app,
	}
}

func doJSON(t *testing.T, app *fiber.App, method, path, body string) (*http.Response, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 1024)
	for {
		n, _ := resp.Body.Read(tmp)
		if n == 0 {
			break
		}
		buf = append(buf, tmp[:n]...)
	}
	return resp, buf
}

func auditCount(t *testing.T, fx *fixture) int {
	t.Helper()
	var n int
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM payout_audit_log WHERE payout_id = $1::uuid`, fx.payoutID,
	).Scan(&n); err != nil {
		t.Fatalf("count audit: %v", err)
	}
	return n
}

func TestWorkerSummary(t *testing.T) {
	fx := newFixture(t)
	resp, body := doJSON(t, fx.app, "GET", "/workers/"+fx.proID+"/payroll-payouts", "")
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d body=%s", resp.StatusCode, string(body))
	}
	var got crmpayroll.WorkerPayoutSummary
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.LifetimePaidPaise != 0 {
		t.Fatalf("lifetime paid: want 0, got %d", got.LifetimePaidPaise)
	}
	if len(got.RecentPayouts) != 1 {
		t.Fatalf("recent: want 1 row, got %d", len(got.RecentPayouts))
	}
}

func TestMarkPaid_HappyPath(t *testing.T) {
	fx := newFixture(t)
	resp, body := doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/mark-paid",
		`{"notes":"bank transfer ref ABC"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d body=%s", resp.StatusCode, string(body))
	}
	var got crmpayroll.Payout
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Status != "paid" {
		t.Fatalf("status: want paid, got %s", got.Status)
	}
	if got.PaidAt == nil {
		t.Fatalf("paid_at not set")
	}
	if got.PaidByAdminID == nil || *got.PaidByAdminID != fx.adminID {
		t.Fatalf("paid_by_admin_id mismatch: got %v want %s", got.PaidByAdminID, fx.adminID)
	}
	if auditCount(t, fx) != 1 {
		t.Fatalf("audit row: want 1, got %d", auditCount(t, fx))
	}
}

func TestMarkPaid_DoubleConflict(t *testing.T) {
	fx := newFixture(t)
	_, _ = doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/mark-paid", `{}`)
	resp, body := doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/mark-paid", `{}`)
	if resp.StatusCode != 409 {
		t.Fatalf("expected 409 on second mark-paid, got %d body=%s", resp.StatusCode, string(body))
	}
}

func TestMarkFailed_ReversesPaid(t *testing.T) {
	fx := newFixture(t)
	_, _ = doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/mark-paid", `{}`)
	resp, body := doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/mark-failed",
		`{"reason":"wrong amount; recomputing"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d body=%s", resp.StatusCode, string(body))
	}
	var got crmpayroll.Payout
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Status != "failed" {
		t.Fatalf("status: want failed, got %s", got.Status)
	}
	if got.PaidAt == nil {
		t.Fatalf("paid_at MUST be preserved after mark-failed reversal of a paid row")
	}
	if got.PaidByAdminID == nil || *got.PaidByAdminID != fx.adminID {
		t.Fatalf("paid_by_admin_id MUST be preserved after mark-failed reversal; got %v", got.PaidByAdminID)
	}
	if auditCount(t, fx) != 2 {
		t.Fatalf("audit rows: want 2 (paid + failed), got %d", auditCount(t, fx))
	}
}

func TestMarkFailed_EmptyReasonRejected(t *testing.T) {
	fx := newFixture(t)
	resp, _ := doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/mark-failed", `{"reason":""}`)
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestRecompute_FromPendingUpdatesValues(t *testing.T) {
	fx := newFixture(t)

	// Seed a closed shift session for this pro inside the cycle so the
	// recompute produces non-zero numbers. 120 online min + 60 working min.
	commitID := uuid.NewString()
	if _, err := fx.pool.Exec(context.Background(), `
		INSERT INTO shift_commitments (id, pro_id, shift_date, start_time, end_time, status, locked_at)
		VALUES ($1::uuid, $2::uuid, '2026-05-10', '09:00', '17:00', 'completed', now())
	`, commitID, fx.proID); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	if _, err := fx.pool.Exec(context.Background(), `
		INSERT INTO shift_sessions (commitment_id, pro_id, online_at, offline_at, online_minutes, job_minutes)
		VALUES ($1::uuid, $2::uuid, '2026-05-10 09:00:00+05:30', '2026-05-10 11:00:00+05:30', 120, 60)
	`, commitID, fx.proID); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	resp, body := doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/recompute", ``)
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d body=%s", resp.StatusCode, string(body))
	}
	var got crmpayroll.Payout
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.OnlineMinutes != 120 || got.WorkingMinutes != 60 {
		t.Fatalf("recompute minutes: want 120/60, got %d/%d", got.OnlineMinutes, got.WorkingMinutes)
	}
	// 120min * 8000 / 60 = 16000 paise (₹160); + 60min * 8000 / 60 = 8000 (₹80) = 24000 (₹240)
	if got.BasePayPaise != 16000 || got.WorkBonusPaise != 8000 || got.GrossPayPaise != 24000 {
		t.Fatalf("recompute pay: want 16000/8000/24000, got %d/%d/%d",
			got.BasePayPaise, got.WorkBonusPaise, got.GrossPayPaise)
	}
	if auditCount(t, fx) != 1 {
		t.Fatalf("audit row: want 1, got %d", auditCount(t, fx))
	}
}

func TestRecompute_PaidRowIs403(t *testing.T) {
	fx := newFixture(t)
	_, _ = doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/mark-paid", `{}`)
	resp, body := doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/recompute", ``)
	if resp.StatusCode != 403 {
		t.Fatalf("expected 403 on recompute-paid, got %d body=%s", resp.StatusCode, string(body))
	}
}

// TestRecompute_FailedFlipsToPending asserts the May-21 fix: recompute on a
// row in status='failed' resets status back to 'pending_manual_payout' and
// clears failure_reason, so the admin can immediately re-attempt mark-paid.
// Recompute on an already-pending row leaves status untouched (covered by
// TestRecompute_FromPendingUpdatesValues).
func TestRecompute_FailedFlipsToPending(t *testing.T) {
	fx := newFixture(t)
	ctx := context.Background()

	// Drop the seeded row into status='failed' with a non-NULL reason so we
	// can verify the recompute clears it. Direct SQL is simpler than walking
	// mark-paid → mark-failed and gives us a deterministic failure_reason.
	if _, err := fx.pool.Exec(ctx, `
		UPDATE payouts
		   SET status = 'failed', failure_reason = 'imps_bounce'
		 WHERE id = $1::uuid
	`, fx.payoutID); err != nil {
		t.Fatalf("seed failed row: %v", err)
	}

	// Seed a closed shift session inside the cycle so recompute writes
	// non-zero numbers (proves the numeric SET legs still fire).
	commitID := uuid.NewString()
	if _, err := fx.pool.Exec(ctx, `
		INSERT INTO shift_commitments (id, pro_id, shift_date, start_time, end_time, status, locked_at)
		VALUES ($1::uuid, $2::uuid, '2026-05-10', '09:00', '17:00', 'completed', now())
	`, commitID, fx.proID); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	if _, err := fx.pool.Exec(ctx, `
		INSERT INTO shift_sessions (commitment_id, pro_id, online_at, offline_at, online_minutes, job_minutes)
		VALUES ($1::uuid, $2::uuid, '2026-05-10 09:00:00+05:30', '2026-05-10 11:00:00+05:30', 120, 60)
	`, commitID, fx.proID); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	resp, body := doJSON(t, fx.app, "POST", "/payroll/payouts/"+fx.payoutID+"/recompute", ``)
	if resp.StatusCode != 200 {
		t.Fatalf("recompute status: %d body=%s", resp.StatusCode, string(body))
	}
	var got crmpayroll.Payout
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if got.Status != "pending_manual_payout" {
		t.Fatalf("status: want pending_manual_payout, got %q", got.Status)
	}
	if got.FailureReason != nil {
		t.Fatalf("failure_reason: want NULL, got %q", *got.FailureReason)
	}
	if got.OnlineMinutes != 120 || got.WorkingMinutes != 60 {
		t.Fatalf("numbers not recomputed: want 120/60, got %d/%d",
			got.OnlineMinutes, got.WorkingMinutes)
	}

	// Audit row covers the status transition via the before/after JSONB
	// snapshots (no schema change for an explicit status_changed field).
	if auditCount(t, fx) != 1 {
		t.Fatalf("audit row: want 1, got %d", auditCount(t, fx))
	}
	var beforeStatus, afterStatus string
	var beforeReason *string
	if err := fx.pool.QueryRow(ctx, `
		SELECT before_state->>'status', after_state->>'status',
		       before_state->>'failure_reason'
		  FROM payout_audit_log
		 WHERE payout_id = $1::uuid
		 ORDER BY created_at DESC
		 LIMIT 1
	`, fx.payoutID).Scan(&beforeStatus, &afterStatus, &beforeReason); err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if beforeStatus != "failed" || afterStatus != "pending_manual_payout" {
		t.Fatalf("audit status transition: want failed→pending_manual_payout, got %s→%s",
			beforeStatus, afterStatus)
	}
	if beforeReason == nil || *beforeReason != "imps_bounce" {
		t.Fatalf("audit before_state.failure_reason: want imps_bounce, got %v", beforeReason)
	}
}
