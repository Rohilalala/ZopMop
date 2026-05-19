package shift_test

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/shift"
)

// PR#7 hostile-review FIX 1 + FIX 3 regression coverage. Runs against
// the local dev DB (DATABASE_URL or the compose default). Skips if no DB.
func dsn() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://househelp:localdev123@localhost:5432/househelp_db"
}

type zarFixture struct {
	pool       *pgxpool.Pool
	customerID string
	proUserID  string
	commitID   string
	requestID  string
}

func newZARFixture(t *testing.T) *zarFixture {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn())
	if err != nil {
		t.Skipf("no DB: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("no DB: %v", err)
	}
	f := &zarFixture{pool: pool}
	ph1 := "9" + uuid.NewString()[:9]
	ph2 := "8" + uuid.NewString()[:9]
	mustScan(t, pool, &f.customerID, `INSERT INTO users (phone, role) VALUES ($1,'customer') RETURNING id::text`, ph1)
	mustScan(t, pool, &f.proUserID, `INSERT INTO users (phone, role) VALUES ($1,'pro') RETURNING id::text`, ph2)
	mustExec(t, pool, `INSERT INTO helpers (id) VALUES ($1::uuid)`, f.proUserID)
	mustScan(t, pool, &f.commitID, `INSERT INTO shift_commitments (pro_id, shift_date, start_time, end_time) VALUES ($1::uuid, CURRENT_DATE, '09:00','18:00') RETURNING id::text`, f.proUserID)
	mustScan(t, pool, &f.requestID, `INSERT INTO zone_approval_requests (pro_id, shift_commitment_id, current_lat, current_lng) VALUES ($1::uuid,$2::uuid,12.9,77.6) RETURNING id::text`, f.proUserID, f.commitID)
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM zone_approval_requests WHERE id=$1::uuid`, f.requestID)
		pool.Exec(c, `DELETE FROM shift_commitments WHERE id=$1::uuid`, f.commitID)
		pool.Exec(c, `DELETE FROM helpers WHERE id=$1::uuid`, f.proUserID)
		pool.Exec(c, `DELETE FROM users WHERE id IN ($1::uuid,$2::uuid)`, f.customerID, f.proUserID)
		pool.Close()
	})
	return f
}

func mustExec(t *testing.T, p *pgxpool.Pool, q string, args ...any) {
	t.Helper()
	if _, err := p.Exec(context.Background(), q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}
func mustScan(t *testing.T, p *pgxpool.Pool, dst *string, q string, args ...any) {
	t.Helper()
	if err := p.QueryRow(context.Background(), q, args...).Scan(dst); err != nil {
		t.Fatalf("scan %q: %v", q, err)
	}
}
func statusOf(t *testing.T, p *pgxpool.Pool, id string) string {
	t.Helper()
	var s string
	mustScan(t, p, &s, `SELECT status FROM zone_approval_requests WHERE id=$1::uuid`, id)
	return s
}

func TestZoneApproval_S1_ApproveFreshPending(t *testing.T) {
	f := newZARFixture(t)
	svc := shift.NewService(shift.NewRepository(f.pool))
	if err := svc.ApproveZoneRequest(context.Background(), f.requestID, uuid.NewString()); err != nil {
		t.Fatalf("S1 expected nil, got %v", err)
	}
	if got := statusOf(t, f.pool, f.requestID); got != "approved" {
		t.Fatalf("S1 expected status=approved, got %s", got)
	}
}

func TestZoneApproval_S2_ApproveAlreadyApproved(t *testing.T) {
	f := newZARFixture(t)
	svc := shift.NewService(shift.NewRepository(f.pool))
	if err := svc.ApproveZoneRequest(context.Background(), f.requestID, uuid.NewString()); err != nil {
		t.Fatalf("S2 first approve: %v", err)
	}
	err := svc.ApproveZoneRequest(context.Background(), f.requestID, uuid.NewString())
	if !errors.Is(err, shift.ErrAlreadyReviewed) {
		t.Fatalf("S2 expected ErrAlreadyReviewed, got %v", err)
	}
}

func TestZoneApproval_S3_RejectFreshPending(t *testing.T) {
	f := newZARFixture(t)
	svc := shift.NewService(shift.NewRepository(f.pool))
	if err := svc.RejectZoneRequest(context.Background(), f.requestID, uuid.NewString(), "bad selfie"); err != nil {
		t.Fatalf("S3 expected nil, got %v", err)
	}
	if got := statusOf(t, f.pool, f.requestID); got != "rejected" {
		t.Fatalf("S3 expected status=rejected, got %s", got)
	}
}

func TestZoneApproval_S4_RejectAlreadyRejected(t *testing.T) {
	f := newZARFixture(t)
	svc := shift.NewService(shift.NewRepository(f.pool))
	if err := svc.RejectZoneRequest(context.Background(), f.requestID, uuid.NewString(), "x"); err != nil {
		t.Fatalf("S4 first reject: %v", err)
	}
	err := svc.RejectZoneRequest(context.Background(), f.requestID, uuid.NewString(), "y")
	if !errors.Is(err, shift.ErrAlreadyReviewed) {
		t.Fatalf("S4 expected ErrAlreadyReviewed, got %v", err)
	}
}

func TestZoneApproval_S5_RaceTwoApprovals(t *testing.T) {
	f := newZARFixture(t)
	svc := shift.NewService(shift.NewRepository(f.pool))
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			errs[idx] = svc.ApproveZoneRequest(ctx, f.requestID, uuid.NewString())
		}(i)
	}
	wg.Wait()
	nilCount, reviewedCount := 0, 0
	for _, e := range errs {
		switch {
		case e == nil:
			nilCount++
		case errors.Is(e, shift.ErrAlreadyReviewed):
			reviewedCount++
		default:
			t.Fatalf("S5 unexpected err: %v", e)
		}
	}
	if nilCount != 1 || reviewedCount != 1 {
		t.Fatalf("S5 expected exactly 1 success + 1 already_reviewed, got nil=%d reviewed=%d", nilCount, reviewedCount)
	}
}
