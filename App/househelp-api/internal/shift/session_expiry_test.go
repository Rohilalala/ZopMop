package shift_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/shift"
)

func openExpiryDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dsn())
	if err != nil {
		t.Skipf("no DB: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Skipf("no DB: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedOnlinePro creates a pro + a TODAY commitment [start,end] + an open
// session (offline_at NULL), and registers cleanup. Returns their ids.
func seedOnlinePro(t *testing.T, pool *pgxpool.Pool, start, end string) (proID, commitID, sessionID string) {
	t.Helper()
	ph := "7" + uuid.NewString()[:9]
	mustScan(t, pool, &proID, `INSERT INTO users (phone, role) VALUES ($1,'pro') RETURNING id::text`, ph)
	mustExec(t, pool, `INSERT INTO helpers (id) VALUES ($1::uuid)`, proID)
	mustScan(t, pool, &commitID, `INSERT INTO shift_commitments (pro_id, shift_date, start_time, end_time, status) VALUES ($1::uuid, CURRENT_DATE, $2, $3, 'active') RETURNING id::text`, proID, start, end)
	mustScan(t, pool, &sessionID, `INSERT INTO shift_sessions (commitment_id, pro_id) VALUES ($1::uuid, $2::uuid) RETURNING id::text`, commitID, proID)
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM shift_sessions WHERE id=$1::uuid`, sessionID)
		pool.Exec(c, `DELETE FROM shift_commitments WHERE id=$1::uuid`, commitID)
		pool.Exec(c, `DELETE FROM helpers WHERE id=$1::uuid`, proID)
		pool.Exec(c, `DELETE FROM users WHERE id=$1::uuid`, proID)
	})
	return
}

func sessionOfflineSet(t *testing.T, pool *pgxpool.Pool, sessionID string) bool {
	t.Helper()
	var set bool
	if err := pool.QueryRow(context.Background(),
		`SELECT offline_at IS NOT NULL FROM shift_sessions WHERE id=$1::uuid`, sessionID).Scan(&set); err != nil {
		t.Fatalf("read offline_at: %v", err)
	}
	return set
}

// The reported bug: a pro stayed online all day. The sweep must force-close a
// session whose shift window has already ended, and mark the commitment done.
func TestExpireStaleSessions_ClosesExpiredShift(t *testing.T) {
	pool := openExpiryDB(t)
	proID, commitID, sessionID := seedOnlinePro(t, pool, "00:00", "00:01") // window already past today
	_ = proID

	svc := shift.NewService(shift.NewRepository(pool))
	closed, err := svc.ExpireStaleSessions(context.Background())
	if err != nil {
		t.Fatalf("ExpireStaleSessions: %v", err)
	}
	if closed < 1 {
		t.Fatalf("expected >=1 expired session closed, got %d", closed)
	}
	if !sessionOfflineSet(t, pool, sessionID) {
		t.Fatalf("expected offline_at set on the expired session")
	}
	var status string
	pool.QueryRow(context.Background(), `SELECT status FROM shift_commitments WHERE id=$1::uuid`, commitID).Scan(&status)
	if status != "completed" {
		t.Fatalf("expected commitment status 'completed', got %q", status)
	}
}

// A shift still within its window must NOT be force-closed.
func TestExpireStaleSessions_SkipsActiveShift(t *testing.T) {
	pool := openExpiryDB(t)
	_, _, sessionID := seedOnlinePro(t, pool, "00:00", "23:59") // window runs until end of day

	svc := shift.NewService(shift.NewRepository(pool))
	if _, err := svc.ExpireStaleSessions(context.Background()); err != nil {
		t.Fatalf("ExpireStaleSessions: %v", err)
	}
	if sessionOfflineSet(t, pool, sessionID) {
		t.Fatalf("an in-window shift must stay online (offline_at must remain NULL)")
	}
}
