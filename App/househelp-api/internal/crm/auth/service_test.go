package auth

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

// ── DB-backed integration tests ──────────────────────────────────────────
//
// These exercise the refresh-token replay-detection contract introduced for
// audit C-2 / A1-F1. Skipped automatically when TEST_DATABASE_URL is unset.
// Set it to a Postgres URL with the CRM schema migrated up to 072.

func openCRMTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed CRM auth tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// makeTestAdmin inserts a synthetic crm_admins row and returns its ID.
// Cleaned up via t.Cleanup. Email is unique-per-test so parallel runs do
// not collide on crm_admins.email's UNIQUE index.
func makeTestAdmin(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	id := uuid.NewString()
	email := "test-" + id[:8] + "@zopmop.local"
	_, err := pool.Exec(context.Background(), `
		INSERT INTO crm_admins (id, email, password_hash, display_name, role, is_active)
		VALUES ($1::uuid, $2, '$2a$10$dummy', $3, 'admin', TRUE)
	`, id, email, "Test "+id[:8])
	if err != nil {
		t.Fatalf("insert admin: %v", err)
	}
	t.Cleanup(func() {
		// Sessions cascade via FK ON DELETE CASCADE.
		_, _ = pool.Exec(context.Background(), `DELETE FROM crm_admins WHERE id=$1::uuid`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM crm_audit_log WHERE admin_id=$1::uuid`, id)
	})
	return id
}

// seedSession creates an active-leg session for the admin with a known
// plaintext refresh token. Returns (sessionID, plaintext).
func seedSession(t *testing.T, repo *Repository, adminID string, ttl time.Duration) (string, string) {
	t.Helper()
	plaintext, hash, err := GenerateRefreshToken()
	if err != nil {
		t.Fatalf("gen token: %v", err)
	}
	sessID := uuid.NewString()
	now := time.Now()
	if err := repo.CreateSession(context.Background(), &Session{
		ID:               sessID,
		AdminID:          adminID,
		RefreshTokenHash: hash,
		IssuedAt:         now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(ttl),
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	return sessID, plaintext
}

// newTestService builds a Service + audit Recorder with a short grace window
// so tests don't have to sleep multiple seconds.
func newTestService(t *testing.T, pool *pgxpool.Pool, graceWindow time.Duration) (*Service, *audit.Recorder) {
	t.Helper()
	repo := NewRepository(pool)
	rec := audit.NewRecorder(pool)
	svc := NewService(repo, Config{
		JWTSecret:          "test-secret-1234567890abcdefghijklmnopqr",
		JWTSecretID:        "test-kid",
		AccessTokenTTL:     15 * time.Minute,
		RefreshTokenTTL:    24 * time.Hour,
		RefreshGraceWindow: graceWindow,
	})
	svc.SetRecorder(rec)
	return svc, rec
}

// fetchSession is a low-level helper that bypasses the repo's filtering
// and returns the raw rotated_at / revoked_at / replay_detected_at for
// assertions. nil pointers reflect NULL columns.
type rawSession struct {
	ID               string
	FamilyID         string
	RotatedAt        *time.Time
	RotatedTo        *string
	RevokedAt        *time.Time
	ReplayDetectedAt *time.Time
}

func fetchSession(t *testing.T, pool *pgxpool.Pool, sessID string) rawSession {
	t.Helper()
	var r rawSession
	err := pool.QueryRow(context.Background(), `
		SELECT id::text, family_id::text, rotated_at, rotated_to::text,
		       revoked_at, replay_detected_at
		FROM crm_admin_sessions
		WHERE id = $1::uuid
	`, sessID).Scan(&r.ID, &r.FamilyID, &r.RotatedAt, &r.RotatedTo,
		&r.RevokedAt, &r.ReplayDetectedAt)
	if err != nil {
		t.Fatalf("fetch session %s: %v", sessID, err)
	}
	return r
}

func countAuditRows(t *testing.T, pool *pgxpool.Pool, action, targetID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM crm_audit_log
		WHERE action = $1 AND target_id = $2
	`, action, targetID).Scan(&n); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	return n
}

// ── Tests ────────────────────────────────────────────────────────────────

func TestRefresh_HappyPath(t *testing.T) {
	pool := openCRMTestDB(t)
	svc, _ := newTestService(t, pool, time.Second)
	repo := svc.repo
	adminID := makeTestAdmin(t, pool)
	oldID, plaintext := seedSession(t, repo, adminID, 24*time.Hour)

	res, err := svc.Refresh(context.Background(), plaintext, "test-ua", "127.0.0.1", "req-1")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if res.SessionID == oldID {
		t.Fatalf("new session id should differ from old: %s", res.SessionID)
	}
	if res.RefreshTokenPlaintext == plaintext {
		t.Fatalf("new refresh plaintext should differ from old")
	}

	old := fetchSession(t, pool, oldID)
	if old.RotatedAt == nil {
		t.Fatalf("old session rotated_at should be set after rotation")
	}
	if old.RotatedTo == nil || *old.RotatedTo != res.SessionID {
		t.Fatalf("old.rotated_to should point at new session id; got %v want %s", old.RotatedTo, res.SessionID)
	}
	new := fetchSession(t, pool, res.SessionID)
	if new.FamilyID != old.FamilyID {
		t.Fatalf("successor family_id %s should match predecessor %s", new.FamilyID, old.FamilyID)
	}
	if new.RotatedAt != nil {
		t.Fatalf("new session rotated_at should be NULL until next rotation")
	}
	if new.RevokedAt != nil {
		t.Fatalf("new session must not be born revoked")
	}
}

func TestRefresh_GraceWindow(t *testing.T) {
	pool := openCRMTestDB(t)
	// 1s window — first refresh rotates, second within ~50ms is benign.
	svc, _ := newTestService(t, pool, time.Second)
	repo := svc.repo
	adminID := makeTestAdmin(t, pool)
	oldID, plaintext := seedSession(t, repo, adminID, 24*time.Hour)

	if _, err := svc.Refresh(context.Background(), plaintext, "ua", "127.0.0.1", "req-1"); err != nil {
		t.Fatalf("first refresh failed: %v", err)
	}

	// Replay the same plaintext within the grace window. This is a benign
	// rotation race (the successor cookie was just issued), so the service
	// returns ErrSessionRotationRace — NOT ErrSessionExpired — so the client
	// keeps its fresh cookie instead of being logged out.
	_, err := svc.Refresh(context.Background(), plaintext, "ua", "127.0.0.1", "req-2")
	if !errors.Is(err, ErrSessionRotationRace) {
		t.Fatalf("grace-window replay should return ErrSessionRotationRace, got %v", err)
	}

	// Family must NOT be killed (no replay_detected_at on old row).
	old := fetchSession(t, pool, oldID)
	if old.ReplayDetectedAt != nil {
		t.Fatalf("grace-window replay must not set replay_detected_at")
	}
	if old.RevokedAt != nil {
		t.Fatalf("grace-window replay must not revoke the family")
	}
	if got := countAuditRows(t, pool, "auth.session_replay_detected", old.FamilyID); got != 0 {
		t.Fatalf("grace-window replay must not write audit row, got %d", got)
	}
}

func TestRefresh_ReplayDetection(t *testing.T) {
	pool := openCRMTestDB(t)
	// Short window so we can exit it with a brief sleep.
	svc, _ := newTestService(t, pool, 100*time.Millisecond)
	repo := svc.repo
	adminID := makeTestAdmin(t, pool)
	oldID, plaintext := seedSession(t, repo, adminID, 24*time.Hour)

	// First refresh: A → B.
	if _, err := svc.Refresh(context.Background(), plaintext, "ua", "127.0.0.1", "req-1"); err != nil {
		t.Fatalf("first refresh failed: %v", err)
	}

	// Wait beyond the grace window. Re-presentation now is replay.
	time.Sleep(250 * time.Millisecond)

	_, err := svc.Refresh(context.Background(), plaintext, "ua", "10.0.0.1", "req-2")
	if !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("replay should return ErrSessionExpired, got %v", err)
	}

	// Entire family must be revoked + replay_detected_at stamped.
	old := fetchSession(t, pool, oldID)
	if old.RevokedAt == nil {
		t.Fatalf("replay must revoke old row")
	}
	if old.ReplayDetectedAt == nil {
		t.Fatalf("replay must stamp replay_detected_at on old row")
	}
	if old.RotatedTo == nil {
		t.Fatalf("expected rotated_to set on old row")
	}
	successor := fetchSession(t, pool, *old.RotatedTo)
	if successor.RevokedAt == nil {
		t.Fatalf("replay must revoke successor (whole family)")
	}
	if successor.ReplayDetectedAt == nil {
		t.Fatalf("replay must stamp replay_detected_at on successor")
	}

	// Exactly one audit row written for this family.
	if got := countAuditRows(t, pool, "auth.session_replay_detected", old.FamilyID); got != 1 {
		t.Fatalf("expected 1 replay audit row, got %d", got)
	}
}

func TestRefresh_ConcurrentRotate(t *testing.T) {
	pool := openCRMTestDB(t)
	svc, _ := newTestService(t, pool, 5*time.Second)
	repo := svc.repo
	adminID := makeTestAdmin(t, pool)
	oldID, plaintext := seedSession(t, repo, adminID, 24*time.Hour)

	const N = 5
	var (
		wg        sync.WaitGroup
		successes atomic.Int64
		races     atomic.Int64
		other     atomic.Int64
	)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.Refresh(context.Background(), plaintext, "ua", "127.0.0.1", "req-x")
			switch {
			case err == nil:
				successes.Add(1)
			case errors.Is(err, ErrSessionRotationRace):
				races.Add(1)
			default:
				other.Add(1)
			}
		}()
	}
	wg.Wait()

	// Exactly one goroutine wins the CAS rotation; the rest lose it (or read
	// the row already-rotated within the grace window) and get the benign
	// ErrSessionRotationRace — never ErrSessionExpired, never a hard error.
	if successes.Load() != 1 {
		t.Fatalf("expected exactly 1 successful refresh, got successes=%d races=%d other=%d",
			successes.Load(), races.Load(), other.Load())
	}
	if races.Load() != N-1 {
		t.Fatalf("expected %d ErrSessionRotationRace, got %d", N-1, races.Load())
	}
	if other.Load() != 0 {
		t.Fatalf("unexpected non-sentinel errors: %d", other.Load())
	}

	// Family must be intact (no replay_detected_at). Old row should be
	// rotated exactly once with one successor row in the family.
	old := fetchSession(t, pool, oldID)
	if old.ReplayDetectedAt != nil {
		t.Fatalf("concurrent legit retries must not trigger family kill")
	}
	if old.RotatedAt == nil || old.RotatedTo == nil {
		t.Fatalf("winner's rotation should leave old row in rotated state")
	}

	// Count rows in family — exactly 2 (old + one successor).
	var familyRows int
	if err := pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM crm_admin_sessions WHERE family_id = $1::uuid
	`, old.FamilyID).Scan(&familyRows); err != nil {
		t.Fatalf("count family rows: %v", err)
	}
	if familyRows != 2 {
		t.Fatalf("expected 2 family rows after one successful rotation, got %d", familyRows)
	}
}
