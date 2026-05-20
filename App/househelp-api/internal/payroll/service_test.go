package payroll_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/payroll"
)

// dsn returns the DB connection string for integration-style smoke
// tests. Skips if no DB reachable (e.g. CI vet-only runs).
func dsn() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://househelp:localdev123@localhost:5432/househelp_db"
}

type cycleFixture struct {
	pool  *pgxpool.Pool
	proID string
	cycle payroll.CycleClose
}

func newCycleFixture(t *testing.T) *cycleFixture {
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

	phone := "+91-test-" + uuid.NewString()[:8]
	userID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, phone, name, role)
		VALUES ($1::uuid, $2, 'PayrollTest', 'pro')
	`, userID, phone); err != nil {
		pool.Close()
		t.Fatalf("seed user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO helpers (id, effective_start_date)
		VALUES ($1::uuid, '2026-01-01')
	`, userID); err != nil {
		pool.Close()
		t.Fatalf("seed helper: %v", err)
	}

	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM payouts WHERE pro_id = $1::uuid`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM helpers WHERE id = $1::uuid`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1::uuid`, userID)
		pool.Close()
	})

	return &cycleFixture{
		pool:  pool,
		proID: userID,
		cycle: payroll.CycleClose{
			Start: time.Date(2026, time.May, 1, 0, 0, 0, 0, payroll.Location()),
			End:   time.Date(2026, time.May, 15, 0, 0, 0, 0, payroll.Location()),
		},
	}
}

// TestRunCycle_WritesZerosForInactivePro verifies that a pro with no
// shift activity still gets a payouts row written (audit trail per
// the design's edge-case list).
func TestRunCycle_WritesZerosForInactivePro(t *testing.T) {
	fx := newCycleFixture(t)
	svc := payroll.NewService(payroll.NewRepository(fx.pool))

	res, err := svc.RunCycle(context.Background(), fx.cycle)
	if err != nil {
		t.Fatalf("RunCycle: %v", err)
	}
	if res.PayoutsInserted < 1 {
		t.Fatalf("expected at least one inserted row, got %d", res.PayoutsInserted)
	}

	var online, working int
	var gross int64
	var status string
	err = fx.pool.QueryRow(context.Background(), `
		SELECT online_minutes, working_minutes, gross_pay_paise, status
		  FROM payouts
		 WHERE pro_id = $1::uuid AND cycle_start = $2::date
	`, fx.proID, fx.cycle.StartDate()).Scan(&online, &working, &gross, &status)
	if err != nil {
		t.Fatalf("read payout row: %v", err)
	}
	if online != 0 || working != 0 || gross != 0 {
		t.Fatalf("zero-activity row should be all zeros, got online=%d working=%d gross=%d", online, working, gross)
	}
	if status != "pending_manual_payout" {
		t.Fatalf("status: want pending_manual_payout, got %q", status)
	}
}

// TestRunCycle_Idempotent verifies that re-running the same cycle
// does not duplicate rows. UpsertPayout uses ON CONFLICT DO NOTHING.
func TestRunCycle_Idempotent(t *testing.T) {
	fx := newCycleFixture(t)
	svc := payroll.NewService(payroll.NewRepository(fx.pool))

	res1, err := svc.RunCycle(context.Background(), fx.cycle)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	res2, err := svc.RunCycle(context.Background(), fx.cycle)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if res2.PayoutsInserted != 0 {
		t.Fatalf("second run should insert zero rows, inserted %d", res2.PayoutsInserted)
	}
	if res2.PayoutsSkipped < res1.PayoutsInserted {
		t.Fatalf("second run should skip what the first inserted: inserted=%d skipped=%d", res1.PayoutsInserted, res2.PayoutsSkipped)
	}

	// Defensive: count rows for our pro — must be exactly one.
	var n int
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM payouts WHERE pro_id = $1::uuid AND cycle_start = $2::date`,
		fx.proID, fx.cycle.StartDate(),
	).Scan(&n); err != nil {
		t.Fatalf("count payouts: %v", err)
	}
	if n != 1 {
		t.Fatalf("want exactly 1 payout row, got %d", n)
	}
}

// TestRunCycle_SkipsProJoinedAfterCycleEnd verifies the
// effective_start_date filter on EligibleHelpers.
func TestRunCycle_SkipsProJoinedAfterCycleEnd(t *testing.T) {
	fx := newCycleFixture(t)

	// Move this pro's effective_start_date to AFTER cycle_end.
	if _, err := fx.pool.Exec(context.Background(),
		`UPDATE helpers SET effective_start_date = '2026-06-01' WHERE id = $1::uuid`,
		fx.proID,
	); err != nil {
		t.Fatalf("update helper start date: %v", err)
	}

	svc := payroll.NewService(payroll.NewRepository(fx.pool))
	if _, err := svc.RunCycle(context.Background(), fx.cycle); err != nil {
		t.Fatalf("RunCycle: %v", err)
	}

	var n int
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM payouts WHERE pro_id = $1::uuid`,
		fx.proID,
	).Scan(&n); err != nil {
		t.Fatalf("count payouts: %v", err)
	}
	if n != 0 {
		t.Fatalf("pro joined after cycle_end should get zero payouts, got %d", n)
	}
}
