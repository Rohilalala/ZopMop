package roomies

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
)

// Worker runs the auto-settle cron in the background and exposes a
// Stop hook so SIGTERM can drain it cleanly (audit NEW-B1-001).
//
// Auto-settles LedgerDebts stuck in pending_verification for more than
// 48 hours, preventing the "hostage situation" (edge case 3) where a
// creditor refuses to click "Verify" after the debtor has already
// settled externally.
type Worker struct {
	svc    *Service
	cancel context.CancelFunc
	done   chan struct{}
}

// NewWorker constructs (but does not start) a roomies cron worker.
func NewWorker(svc *Service) *Worker {
	return &Worker{svc: svc, done: make(chan struct{})}
}

// Start spawns the goroutine. Calling Start a second time is a no-op.
func (w *Worker) Start(parent context.Context) {
	if w.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	w.cancel = cancel

	go func() {
		defer close(w.done)
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		log.Info().Msg("roomies: auto-settle cron started (interval: 1h, threshold: 48h)")

		for {
			select {
			case <-ctx.Done():
				log.Info().Msg("roomies: auto-settle cron stopping")
				return
			case <-ticker.C:
				runCtx, runCancel := context.WithTimeout(ctx, 30*time.Second)
				n, err := w.svc.AutoSettleStalePendingDebts(runCtx)
				runCancel()

				if err != nil {
					log.Error().Err(err).Msg("roomies: auto-settle cron failed")
				} else if n > 0 {
					log.Info().Int("settled_count", n).Msg("roomies: auto-settled stale pending debts")
				}
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
