package outbox

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// mustOpenDB returns a live pool or skips the test if TEST_DATABASE_URL / DATABASE_URL
// is not set. The pool is closed automatically when the test ends.
func mustOpenDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set — skipping integration test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedRow inserts a row into event_outbox and returns its id.
// status defaults to 'pending'; available_at defaults to NOW()-1s so the
// worker picks it up immediately.
func seedRow(t *testing.T, pool *pgxpool.Pool, eventType string, attemptCount int, status string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO event_outbox
			(event_type, aggregate_id, payload, status, attempt_count, available_at)
		VALUES
			($1, gen_random_uuid(), '{}', $2, $3, NOW() - INTERVAL '1 second')
		RETURNING id::text
	`, eventType, status, attemptCount).Scan(&id)
	if err != nil {
		t.Fatalf("seedRow: %v", err)
	}
	t.Cleanup(func() {
		// best-effort cleanup; ignore errors (row may already be gone)
		pool.Exec(context.Background(), `DELETE FROM event_outbox WHERE id = $1::uuid`, id) //nolint:errcheck
	})
	return id
}

// rowStatus reads the current status column for a given row id.
func rowStatus(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var status string
	err := pool.QueryRow(context.Background(),
		`SELECT status FROM event_outbox WHERE id = $1::uuid`, id,
	).Scan(&status)
	if err != nil {
		t.Fatalf("rowStatus: %v", err)
	}
	return status
}

// TestWorker_MarksRowDone_OnSuccess seeds a pending row, starts a worker
// whose handler returns nil, and asserts the row transitions to 'done'.
func TestWorker_MarksRowDone_OnSuccess(t *testing.T) {
	pool := mustOpenDB(t)

	id := seedRow(t, pool, "test.success", 0, "pending")

	w := NewWorker(pool, 50*time.Millisecond)
	w.Register("test.success", func(_ context.Context, _ Row) error { return nil })
	w.Start()
	defer w.Stop()

	time.Sleep(200 * time.Millisecond)

	if got := rowStatus(t, pool, id); got != "done" {
		t.Errorf("expected status='done', got %q", got)
	}
}

// TestWorker_MarksRowPending_OnRetryableError seeds a pending row, starts a
// worker whose handler always returns an error, and asserts the row is
// re-queued (status='pending') after the first attempt.
func TestWorker_MarksRowPending_OnRetryableError(t *testing.T) {
	pool := mustOpenDB(t)

	id := seedRow(t, pool, "test.retry", 0, "pending")

	w := NewWorker(pool, 50*time.Millisecond)
	w.Register("test.retry", func(_ context.Context, _ Row) error {
		return errors.New("transient error")
	})
	w.Start()
	defer w.Stop()

	time.Sleep(200 * time.Millisecond)

	if got := rowStatus(t, pool, id); got != "pending" {
		t.Errorf("expected status='pending' (re-queued), got %q", got)
	}
}

// TestWorker_MarksRowFailed_AfterMaxAttempts seeds a row with attempt_count=9
// so that the claim CTE increments it to 10 (== maxAttempts). The handler
// returns an error, and dispatch should mark the row 'failed'.
func TestWorker_MarksRowFailed_AfterMaxAttempts(t *testing.T) {
	pool := mustOpenDB(t)

	// Seed with attempt_count=9; after claim increments it → 10 >= maxAttempts(10).
	id := seedRow(t, pool, "test.maxfail", 9, "pending")

	w := NewWorker(pool, 50*time.Millisecond)
	w.Register("test.maxfail", func(_ context.Context, _ Row) error {
		return errors.New("handler error at max attempts")
	})
	w.Start()
	defer w.Stop()

	time.Sleep(200 * time.Millisecond)

	if got := rowStatus(t, pool, id); got != "failed" {
		t.Errorf("expected status='failed', got %q", got)
	}
}

// TestWorker_UseCatchAll_ForUnknownEventType seeds a row with an event type
// that has no specific handler registered. Only a "*" catch-all is registered.
// The row should transition to 'done'.
func TestWorker_UseCatchAll_ForUnknownEventType(t *testing.T) {
	pool := mustOpenDB(t)

	id := seedRow(t, pool, "test.unknown.event.type", 0, "pending")

	w := NewWorker(pool, 50*time.Millisecond)
	w.Register("*", func(_ context.Context, _ Row) error { return nil })
	w.Start()
	defer w.Stop()

	time.Sleep(200 * time.Millisecond)

	if got := rowStatus(t, pool, id); got != "done" {
		t.Errorf("expected status='done' via catch-all handler, got %q", got)
	}
}

// TestWorker_SkipLocked_PreventDoubleProcess seeds a single row and starts
// two workers concurrently. FOR UPDATE SKIP LOCKED guarantees that only one
// worker claims the row, so the handler should be invoked exactly once.
func TestWorker_SkipLocked_PreventDoubleProcess(t *testing.T) {
	pool := mustOpenDB(t)

	id := seedRow(t, pool, "test.skip.locked", 0, "pending")

	var processedCount int64

	handler := func(_ context.Context, _ Row) error {
		atomic.AddInt64(&processedCount, 1)
		return nil
	}

	w1 := NewWorker(pool, 50*time.Millisecond)
	w1.Register("test.skip.locked", handler)
	w1.Start()
	defer w1.Stop()

	w2 := NewWorker(pool, 50*time.Millisecond)
	w2.Register("test.skip.locked", handler)
	w2.Start()
	defer w2.Stop()

	time.Sleep(300 * time.Millisecond)

	if got := atomic.LoadInt64(&processedCount); got != 1 {
		t.Errorf("expected handler invoked exactly once, got %d (row id: %s)", got, id)
	}
}
