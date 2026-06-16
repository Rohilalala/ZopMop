package growth

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Scheduler dispatches scheduled push messages whose scheduled_at is due.
//
// Lock semantics
// --------------
// Each Tick opens a short transaction that does:
//
//	SELECT id FROM crm_push_messages
//	WHERE status='scheduled' AND scheduled_at <= now()
//	ORDER BY scheduled_at LIMIT $1
//	FOR UPDATE SKIP LOCKED
//
// then COMMITs immediately, releasing the row locks. SKIP LOCKED gives us
// best-effort cross-instance dedup at the SELECT step (two crons running
// against the same DB grab disjoint candidate sets), but the *authoritative*
// dedup is the claim-CAS at the TOP of Service.SendPush — it flips
// `status IN ('draft','scheduled')` → 'sending' BEFORE any FCM dispatch and
// reports RowsAffected()==0 if somebody else already claimed the row, so the
// loser aborts before delivering. The terminal status ('sent'/'failed') is
// written after dispatch (WHERE status='sending').
//
// We deliberately do NOT keep the FOR UPDATE transaction open across the
// SendPush call: SendPush's UPDATE runs on a *different* pool connection
// and would block on our own row lock, deadlocking the goroutine until
// statement_timeout fires. The select-then-commit pattern avoids that and
// the CAS gives us the same correctness guarantee.
//
// On crash mid-send: SendPush either (a) hasn't run its claim-CAS yet —
// row stays 'scheduled', the next Tick reprocesses it; or (b) has claimed
// it — row is 'sending' and the next Tick (status='scheduled' only) skips
// it, so a crash between claim and terminal UPDATE leaves the row wedged in
// 'sending' (no double-send; manual requeue needed). Acceptable for a
// marketing-push cron — the prior behaviour double-delivered on every race.
type Scheduler struct {
	svc       *Service
	pool      *pgxpool.Pool
	interval  time.Duration
	batchSize int

	mu      sync.Mutex
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	running bool
}

// SchedulerOption configures a Scheduler. See WithInterval / WithBatchSize.
type SchedulerOption func(*Scheduler)

// WithInterval sets the tick cadence. Default 30s.
func WithInterval(d time.Duration) SchedulerOption {
	return func(s *Scheduler) {
		if d > 0 {
			s.interval = d
		}
	}
}

// WithBatchSize sets the max rows processed per Tick. Default 10.
func WithBatchSize(n int) SchedulerOption {
	return func(s *Scheduler) {
		if n > 0 {
			s.batchSize = n
		}
	}
}

// NewScheduler constructs a Scheduler bound to the given Service + pool.
// pool must be the write pool — Tick takes row locks on crm_push_messages.
func NewScheduler(svc *Service, pool *pgxpool.Pool, opts ...SchedulerOption) *Scheduler {
	s := &Scheduler{
		svc:       svc,
		pool:      pool,
		interval:  30 * time.Second,
		batchSize: 10,
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Start kicks off the tick loop in a background goroutine and returns
// immediately. The loop ticks every interval, calling Tick. The first
// Tick fires after one interval (not immediately) so a fleet rolling
// out at the same moment doesn't all hammer the DB on boot.
//
// Calling Start twice is a no-op — only the first call wins.
func (s *Scheduler) Start(ctx context.Context) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	loopCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.running = true
	s.wg.Add(1)
	s.mu.Unlock()

	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()
		log.Info().Dur("interval", s.interval).Int("batch", s.batchSize).
			Msg("[crm.push.cron] scheduler started")
		for {
			select {
			case <-loopCtx.Done():
				log.Info().Msg("[crm.push.cron] scheduler context cancelled")
				return
			case <-ticker.C:
				processed, err := s.Tick(loopCtx)
				if err != nil && !errors.Is(err, context.Canceled) {
					log.Error().Err(err).Msg("[crm.push.cron] tick failed")
				} else if processed > 0 {
					log.Info().Int("processed", processed).Msg("[crm.push.cron] tick complete")
				}
			}
		}
	}()
}

// Stop signals the loop to exit and waits for the in-flight Tick (if any)
// to complete. Returns context.DeadlineExceeded if the wait exceeds the
// caller's ctx deadline. Safe to call before Start (no-op) and idempotent.
func (s *Scheduler) Stop(ctx context.Context) error {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return nil
	}
	cancel := s.cancel
	s.running = false
	s.cancel = nil
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}

	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		log.Info().Msg("[crm.push.cron] scheduler stopped cleanly")
		return nil
	case <-ctx.Done():
		log.Warn().Msg("[crm.push.cron] scheduler stop deadline exceeded; tick still in flight")
		return ctx.Err()
	}
}

// Tick processes one batch of due scheduled pushes. Returns the number of
// rows for which SendPush was attempted (regardless of dispatch outcome).
// Exposed so tests + an admin "tick now" trigger can drive the loop.
func (s *Scheduler) Tick(ctx context.Context) (int, error) {
	start := time.Now()
	ids, err := s.claimDueIDs(ctx)
	if err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	for _, id := range ids {
		s.dispatchOne(ctx, id)
		if ctx.Err() != nil {
			break
		}
	}
	log.Debug().Int("count", len(ids)).Dur("duration", time.Since(start)).
		Msg("[crm.push.cron] tick batch processed")
	return len(ids), nil
}

// claimDueIDs grabs up to batchSize candidate row IDs inside a short tx,
// then commits to release the row locks. See the package doc on Scheduler
// for why we don't hold the lock across the SendPush call.
func (s *Scheduler) claimDueIDs(ctx context.Context) ([]string, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT id::text
		FROM crm_push_messages
		WHERE status = 'scheduled' AND scheduled_at <= now()
		ORDER BY scheduled_at ASC
		LIMIT $1
		FOR UPDATE SKIP LOCKED
	`, s.batchSize)
	if err != nil {
		return nil, fmt.Errorf("select due: %w", err)
	}
	ids := make([]string, 0, s.batchSize)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit claim tx: %w", err)
	}
	return ids, nil
}

// dispatchOne calls SendPush and recovers from panics so a single bad row
// can't kill the whole tick. SendPush itself flips the row to 'sent' or
// 'failed' (with sent_at + counts); we only need to record an error_message
// + force 'failed' on panic.
func (s *Scheduler) dispatchOne(ctx context.Context, id string) {
	defer func() {
		if r := recover(); r != nil {
			msg := fmt.Sprintf("panic: %v", r)
			// Capture stack so the panic surface isn't silently swallowed
			// (audit NEW-B2-001). Re-panic is unsafe here: dispatchOne is
			// called serially from Tick and a re-panic would unwind the
			// scheduler goroutine, blocking Wait() in Stop(). Stack trace
			// in the log is the minimal observability fix; alerting on
			// "[crm.push.cron] SendPush panicked" should be wired in the
			// log aggregator.
			log.Error().
				Str("push_id", id).
				Str("panic", msg).
				Bytes("stack", debug.Stack()).
				Msg("[crm.push.cron] SendPush panicked")
			s.markPanicFailure(ctx, id, msg)
		}
	}()
	if err := s.svc.SendPush(ctx, id); err != nil {
		// SendPush already updated the row to 'failed' (or never claimed it
		// because another instance won the race). Persist the error_message
		// for the CRM history view; harmless if the row is already terminal.
		s.recordError(ctx, id, err.Error())
		log.Error().Err(err).Str("push_id", id).Msg("[crm.push.cron] dispatch failed")
	}
}

// recordError sets error_message on a row without changing its status. Best
// effort — failures here are logged but never propagate out of the cron.
func (s *Scheduler) recordError(ctx context.Context, id, msg string) {
	if msg == "" {
		return
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE crm_push_messages
		SET error_message = $2
		WHERE id = $1::uuid
	`, id, msg)
	if err != nil {
		log.Warn().Err(err).Str("push_id", id).Msg("[crm.push.cron] failed to record error_message")
	}
}

// markPanicFailure flips a row to 'failed' and records the panic message.
// Used only by the panic recovery in dispatchOne, since SendPush won't have
// completed its own status flip in that case.
func (s *Scheduler) markPanicFailure(ctx context.Context, id, msg string) {
	_, err := s.pool.Exec(ctx, `
		UPDATE crm_push_messages
		SET status = 'failed', sent_at = now(), error_message = $2
		WHERE id = $1::uuid AND status IN ('draft','scheduled')
	`, id, msg)
	if err != nil {
		log.Error().Err(err).Str("push_id", id).Msg("[crm.push.cron] failed to mark panic failure")
	}
}
