package roomies

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
)

// StartAutoSettleCron starts a background goroutine that runs every hour and
// auto-settles LedgerDebts stuck in pending_verification for more than 48 hours.
//
// This prevents the "hostage situation" (edge case 3) where a creditor refuses
// to click "Verify" after the debtor has already settled externally.
func StartAutoSettleCron(svc *Service) {
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		log.Info().Msg("roomies: auto-settle cron started (interval: 1h, threshold: 48h)")

		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			n, err := svc.AutoSettleStalePendingDebts(ctx)
			cancel()

			if err != nil {
				log.Error().Err(err).Msg("roomies: auto-settle cron failed")
			} else if n > 0 {
				log.Info().Int("settled_count", n).Msg("roomies: auto-settled stale pending debts")
			}
		}
	}()
}
