package experiments

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func openTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed experiments tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// TestSetStatus_TransitionGuard proves the experiment state-machine guard:
// only legal transitions apply; illegal ones return ErrInvalidTransition and
// leave the row unchanged. Previously SetStatus ran an unconditional UPDATE.
func TestSetStatus_TransitionGuard(t *testing.T) {
	pool := openTestDB(t)
	repo := NewRepository(pool, pool)
	ctx := context.Background()

	exp, err := repo.Create(ctx, CreateRequest{
		Name:     "guard-test",
		Kind:     "flag",
		Metric:   "conversion",
		Audience: "all",
		Variants: []Variant{{ID: "a", Name: "A", TrafficPct: 50}, {ID: "b", Name: "B", TrafficPct: 50}},
	}, "")
	if err != nil {
		t.Fatalf("create experiment: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM crm_experiments WHERE id=$1::uuid`, exp.ID) })

	// draft -> rolled_out is illegal (allowedFrom[rolled_out] = running|paused|completed).
	if err := repo.SetStatus(ctx, exp.ID, "rolled_out", "a"); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("draft->rolled_out: want ErrInvalidTransition, got %v", err)
	}
	// draft -> running is legal.
	if err := repo.SetStatus(ctx, exp.ID, "running", ""); err != nil {
		t.Fatalf("draft->running: want nil, got %v", err)
	}
	// running -> running is illegal (allowedFrom[running] = draft|paused).
	if err := repo.SetStatus(ctx, exp.ID, "running", ""); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("running->running: want ErrInvalidTransition, got %v", err)
	}
	// running -> rolled_out is legal.
	if err := repo.SetStatus(ctx, exp.ID, "rolled_out", "a"); err != nil {
		t.Fatalf("running->rolled_out: want nil, got %v", err)
	}

	// Confirm final state actually persisted as rolled_out.
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM crm_experiments WHERE id=$1::uuid`, exp.ID).Scan(&status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if status != "rolled_out" {
		t.Fatalf("final status = %q, want rolled_out", status)
	}
}
