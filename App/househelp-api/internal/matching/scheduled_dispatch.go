package matching

// ScheduledDispatcher — nightly 22:00 IST cron.
//
// Walks every unassigned scheduled booking that fires inside the next ~30
// hours, claims it via SELECT FOR UPDATE SKIP LOCKED so multiple instances
// can share the load, and runs InviteChain. Stealth-instant bookings
// (is_stealth_instant=true) are skipped here — they belong to
// StealthDispatcher.
//
// Scheduling: time.Ticker fires every minute; we run when the IST clock hits
// 22:00. A short "ranAt" guard prevents the same hour from firing twice if
// the previous run took > 1 min (defensive — typical run is well under).

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// ScheduledDispatcher drives the nightly batch.
type ScheduledDispatcher struct {
	dispatcher *Dispatcher
	loc        *time.Location // IST — derived from system tzdata once at construction
}

// NewScheduledDispatcher constructs a ScheduledDispatcher.
func NewScheduledDispatcher(d *Dispatcher) *ScheduledDispatcher {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		loc = time.FixedZone("IST", 5*3600+30*60)
	}
	return &ScheduledDispatcher{dispatcher: d, loc: loc}
}

// Start runs the dispatcher loop until ctx is cancelled. Safe to call on a
// goroutine. Runs RunOnce() immediately if the current IST hour is past 22
// AND we've never run today (handy for a process started just after 10pm).
func (s *ScheduledDispatcher) Start(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	var lastRunDay string // "2026-05-03" — guards against double-run within a minute

	tick := func() {
		now := time.Now().In(s.loc)
		if now.Hour() != 22 {
			return
		}
		dayKey := now.Format("2006-01-02")
		if dayKey == lastRunDay {
			return
		}
		lastRunDay = dayKey
		log.Info().Msg("[scheduled-dispatch] nightly run start")
		summary, err := s.RunOnce(ctx)
		if err != nil {
			log.Error().Err(err).Msg("[scheduled-dispatch] run error")
			return
		}
		log.Info().
			Int("processed", summary.Processed).
			Int("assigned", summary.Assigned).
			Int("cancelled", summary.Cancelled).
			Int("preferred_hits", summary.PreferredHits).
			Msg("[scheduled-dispatch] nightly run complete")
	}

	tick() // immediate kick if we're already past 22:00 IST
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("[scheduled-dispatch] ctx cancelled — exiting")
			return
		case <-ticker.C:
			tick()
		}
	}
}

// RunSummary is the per-batch report — emitted to logs after each run.
type RunSummary struct {
	Processed     int
	Assigned      int
	Cancelled     int
	PreferredHits int
}

// RunOnce processes every eligible scheduled booking once. Exported so a
// CRM admin trigger / manual rerun handler can invoke it on demand.
func (s *ScheduledDispatcher) RunOnce(ctx context.Context) (RunSummary, error) {
	summary := RunSummary{}
	for {
		if ctx.Err() != nil {
			return summary, ctx.Err()
		}
		bookingID, customerID, scheduledTime, ok, err := s.claimNext(ctx)
		if err != nil {
			return summary, err
		}
		if !ok {
			return summary, nil // no more rows
		}
		summary.Processed++

		res, err := s.dispatcher.InviteChain(ctx, bookingID)
		if err != nil {
			log.Error().Err(err).Str("booking_id", bookingID).Msg("[scheduled-dispatch] invite chain error")
			continue
		}

		if res.Assigned {
			summary.Assigned++
			if res.Phase == PhasePreferred {
				summary.PreferredHits++
			}
			name := s.dispatcher.helperName(ctx, res.HelperID)
			s.dispatcher.pushCustomerAccepted(ctx, customerID, bookingID, name, res.Phase == PhasePreferred)
			continue
		}

		// Chain exhausted or hard-cap hit with no acceptance — cancel + push.
		if err := s.dispatcher.markBookingNoProsFound(ctx, bookingID); err != nil {
			log.Error().Err(err).Str("booking_id", bookingID).Msg("[scheduled-dispatch] cancel failed")
			continue
		}
		summary.Cancelled++
		when := scheduledTime.In(s.loc).Format("Mon Jan 2 3:04 PM")
		s.dispatcher.pushCustomerNoProsFound(ctx, customerID, bookingID, when)
	}
}

// claimNext picks the next unprocessed scheduled booking via SELECT FOR
// UPDATE SKIP LOCKED. Returns ok=false when the queue is empty.
//
// Selection criteria (from spec §3):
//   status = 'pending'
//   AND time_slot_id IS NOT NULL
//   AND is_stealth_instant = false
//   AND helper_id IS NULL
//   AND scheduled_time BETWEEN now() + 6h AND now() + 30h
//   AND (payment_method != 'cashfree' OR payment_status = 'paid')
//
// The payment-state gate hides Cashfree-pending unpaid bookings — same
// filter the customer-facing list applies. Without it the dispatcher
// would invite helpers for a booking the customer hasn't actually paid
// for yet (or never will, if they bailed on the SDK sheet).
//
// We don't actually update the row inside this tx — InviteChain mutates
// state via its own writes. The lock just prevents two cron instances from
// trying to dispatch the same booking concurrently. We commit immediately
// after locking so the row is "claimed" but other writers can still update
// helper_id (the AcceptBooking path).
func (s *ScheduledDispatcher) claimNext(ctx context.Context) (bookingID, customerID string, scheduledTime time.Time, ok bool, err error) {
	tx, err := s.dispatcher.db.Begin(ctx)
	if err != nil {
		return "", "", time.Time{}, false, err
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx, `
		SELECT id::text, customer_id::text, scheduled_time
		FROM bookings
		WHERE status              = 'pending'
		  AND time_slot_id        IS NOT NULL
		  AND is_stealth_instant  = false
		  AND helper_id           IS NULL
		  AND scheduled_time      BETWEEN now() + interval '6 hours'
		                              AND now() + interval '30 hours'
		  AND (payment_method IS DISTINCT FROM 'cashfree' OR payment_status = 'paid')
		ORDER BY scheduled_time ASC
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`)
	if err := row.Scan(&bookingID, &customerID, &scheduledTime); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", time.Time{}, false, nil
		}
		return "", "", time.Time{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", time.Time{}, false, err
	}
	return bookingID, customerID, scheduledTime, true, nil
}
