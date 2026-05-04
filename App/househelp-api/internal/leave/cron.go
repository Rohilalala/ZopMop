package leave

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
)

// StartMonthlyResetCron runs an hourly background goroutine that refills every
// helper's leave_balance to their monthly_leave_quota at the start of each
// IST calendar month. The underlying SQL is idempotent — only rows whose
// leave_balance_reset_at is older than the current IST month-start get
// touched, so calling this every hour is cheap (zero updates inside the
// month, full refill in the first hour after the 1st rolls over).
//
// We intentionally do not use `time.Until(nextMidnight)`: the lazy-reset path
// in Service.Balance already keeps individual reads fresh, and the hourly
// tick guarantees CRM aggregate views (which read all helpers, not via the
// per-pro path) see the new balance within an hour of midnight. This trades
// a tiny lag at the start of the month for resilience against drift if the
// process restarts during the cron window.
func StartMonthlyResetCron(repo *Repository) {
	go func() {
		// One immediate run at startup catches the case where the process was
		// down through the actual month rollover.
		runOnce(repo)

		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		log.Info().Msg("leave: monthly-reset cron started (interval: 1h)")

		for range ticker.C {
			runOnce(repo)
		}
	}()
}

func runOnce(repo *Repository) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	n, err := repo.ResetExpiredBalances(ctx)
	if err != nil {
		log.Error().Err(err).Msg("leave: monthly-reset cron failed")
		return
	}
	if n > 0 {
		log.Info().Int64("reset_count", n).Msg("leave: monthly balances refilled")
	}
}
