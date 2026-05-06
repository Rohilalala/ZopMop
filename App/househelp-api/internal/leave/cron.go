package leave

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
)

// Worker runs the monthly-reset cron in the background and exposes a
// Stop hook so SIGTERM can drain it cleanly (audit NEW-B1-001).
//
// The underlying SQL is idempotent — only rows whose
// leave_balance_reset_at is older than the current IST month-start get
// touched, so the hourly tick is cheap (zero updates inside the month,
// full refill in the first hour after the 1st rolls over). The lazy-
// reset path in Service.Balance keeps individual reads fresh; the cron
// guarantees CRM aggregate views see the new balance within an hour
// of midnight.
type Worker struct {
	repo   *Repository
	cancel context.CancelFunc
	done   chan struct{}
}

// NewWorker constructs (but does not start) a leave cron worker.
func NewWorker(repo *Repository) *Worker {
	return &Worker{repo: repo, done: make(chan struct{})}
}

// Start spawns the goroutine. Calling Start a second time is a no-op
// (cancel != nil).
func (w *Worker) Start(parent context.Context) {
	if w.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	w.cancel = cancel

	go func() {
		defer close(w.done)
		// One immediate run at startup catches the case where the process
		// was down through the actual month rollover.
		w.runOnce(ctx)

		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		log.Info().Msg("leave: monthly-reset cron started (interval: 1h)")

		for {
			select {
			case <-ctx.Done():
				log.Info().Msg("leave: monthly-reset cron stopping")
				return
			case <-ticker.C:
				w.runOnce(ctx)
			}
		}
	}()
}

// Stop cancels the worker and waits for it to drain or the context to
// fire, whichever comes first.
func (w *Worker) Stop(ctx context.Context) error {
	if w.cancel == nil {
		return nil
	}
	w.cancel()
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *Worker) runOnce(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	n, err := w.repo.ResetExpiredBalances(ctx)
	if err != nil {
		log.Error().Err(err).Msg("leave: monthly-reset cron failed")
		return
	}
	if n > 0 {
		log.Info().Int64("reset_count", n).Msg("leave: monthly balances refilled")
	}
}
