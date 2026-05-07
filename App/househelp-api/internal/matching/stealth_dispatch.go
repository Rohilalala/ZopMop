package matching

// StealthDispatcher — every-1-minute cron for after-8pm-IST bookings.
//
// Bookings created after the cutoff land with is_stealth_instant=true and a
// fire_at = scheduled_time - 15min. Once fire_at passes, this dispatcher:
//
//   1. Flips status from 'pending' → 'searching' so the customer's app shows
//      "Looking for a pro for your booking".
//   2. Runs InviteChain (preferred + general pool, 25s/pro).
//   3. After stealthSearchWindow (15 min from fire_at) with no acceptance:
//        status → 'pending_customer_action'
//        push customer "we're still looking — Keep Looking or Cancel"
//      The customer's choice is handled by booking handler endpoints
//      (out of this package — see /bookings/:id/keep-looking + /cancel).
//
// Concurrency: SELECT FOR UPDATE SKIP LOCKED + a per-row 'searching' status
// transition keeps the same booking from getting picked up twice.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// StealthDispatcher drives the per-minute stealth tick.
type StealthDispatcher struct {
	dispatcher *Dispatcher
}

// NewStealthDispatcher constructs one.
func NewStealthDispatcher(d *Dispatcher) *StealthDispatcher {
	return &StealthDispatcher{dispatcher: d}
}

// Start runs the dispatcher loop until ctx is cancelled.
func (s *StealthDispatcher) Start(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	tick := func() {
		processed, err := s.RunOnce(ctx)
		if err != nil {
			log.Warn().Err(err).Msg("[stealth-dispatch] run error")
			return
		}
		if processed > 0 {
			log.Info().Int("processed", processed).Msg("[stealth-dispatch] tick")
		}
	}

	tick() // immediate run on startup
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("[stealth-dispatch] ctx cancelled — exiting")
			return
		case <-ticker.C:
			tick()
		}
	}
}

// RunOnce processes every fired-and-pending stealth booking once. Returns
// the number of bookings touched.
func (s *StealthDispatcher) RunOnce(ctx context.Context) (int, error) {
	processed := 0
	for {
		if ctx.Err() != nil {
			return processed, ctx.Err()
		}
		bookingID, customerID, scheduledTime, fireAt, ok, err := s.claimNext(ctx)
		if err != nil {
			return processed, err
		}
		if !ok {
			return processed, nil
		}
		processed++

		// Run the chain. The hard-cap inside InviteChain is 30 min; we use
		// stealthSearchWindow (15 min from fire_at) as the actual bound here
		// because the spec says the customer prompt fires at fire_at + 15.
		searchCtx, cancel := context.WithDeadline(ctx, fireAt.Add(stealthSearchWindow))
		res, chainErr := s.dispatcher.InviteChain(searchCtx, bookingID)
		cancel()
		if chainErr != nil && !errors.Is(chainErr, context.DeadlineExceeded) {
			log.Error().Err(chainErr).Str("booking_id", bookingID).Msg("[stealth-dispatch] chain error")
			continue
		}

		if res != nil && res.Assigned {
			// Move out of 'searching' back to 'accepted' — InviteChain has
			// already set helper_id via the AcceptBooking endpoint, so the
			// status field needs catch-up.
			if _, err := s.dispatcher.db.Exec(ctx, `
				UPDATE bookings SET status = 'accepted', updated_at = now()
				WHERE id = $1::uuid AND status = 'searching'
			`, bookingID); err != nil {
				log.Warn().Err(err).Str("booking_id", bookingID).Msg("[stealth-dispatch] status catch-up exec failed")
			}
			name := s.dispatcher.helperName(ctx, res.HelperID)
			s.dispatcher.pushCustomerAccepted(ctx, customerID, bookingID, name, res.Phase == PhasePreferred)
			continue
		}

		// 15-min window expired with no acceptance → ask the customer what to do.
		if err := s.transitionToCustomerAction(ctx, bookingID); err != nil {
			log.Error().Err(err).Str("booking_id", bookingID).Msg("[stealth-dispatch] customer-action transition failed")
			continue
		}
		s.pushStillLooking(ctx, customerID, bookingID, scheduledTime)
	}
}

// claimNext locks the next stealth booking that's ready to dispatch and
// flips it to 'searching' inside the same tx. Returns ok=false on empty queue.
func (s *StealthDispatcher) claimNext(ctx context.Context) (bookingID, customerID string, scheduledTime, fireAt time.Time, ok bool, err error) {
	tx, err := s.dispatcher.db.Begin(ctx)
	if err != nil {
		return "", "", time.Time{}, time.Time{}, false, err
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx, `
		SELECT id::text, customer_id::text, scheduled_time, fire_at
		FROM bookings
		WHERE is_stealth_instant = true
		  AND status             = 'pending'
		  AND helper_id          IS NULL
		  AND fire_at            IS NOT NULL
		  AND fire_at            <= now()
		ORDER BY fire_at ASC
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`)
	if err := row.Scan(&bookingID, &customerID, &scheduledTime, &fireAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", time.Time{}, time.Time{}, false, nil
		}
		return "", "", time.Time{}, time.Time{}, false, err
	}
	// Flip to 'searching' so the customer's match-status feed flips
	// instantly, while we still hold the lock.
	if _, err := tx.Exec(ctx,
		`UPDATE bookings SET status='searching', updated_at=now() WHERE id=$1::uuid`,
		bookingID,
	); err != nil {
		return "", "", time.Time{}, time.Time{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", time.Time{}, time.Time{}, false, err
	}
	return bookingID, customerID, scheduledTime, fireAt, true, nil
}

// transitionToCustomerAction moves a still-unassigned stealth booking into
// the 'pending_customer_action' state — only valid if it's currently
// 'searching' and still has no helper.
func (s *StealthDispatcher) transitionToCustomerAction(ctx context.Context, bookingID string) error {
	_, err := s.dispatcher.db.Exec(ctx, `
		UPDATE bookings
		SET status     = 'pending_customer_action',
		    updated_at = now()
		WHERE id        = $1::uuid
		  AND status    = 'searching'
		  AND helper_id IS NULL
	`, bookingID)
	return err
}

// pushStillLooking nudges the customer with "we're still looking" + the two
// option deep-link types the customer app routes on.
func (s *StealthDispatcher) pushStillLooking(ctx context.Context, customerID, bookingID string, scheduledTime time.Time) {
	if s.dispatcher.notifications == nil {
		return
	}
	when := scheduledTime.In(indiaLoc()).Format("3:04 PM")
	_ = s.dispatcher.notifications.SendData(ctx, customerID, map[string]string{
		"type":       "BOOKING_STILL_LOOKING",
		"booking_id": bookingID,
		"title":      "Still searching",
		"body":       "We're still looking for a pro for your " + when + " booking.",
	})
}

// indiaLoc duplicates booking.indiaLocation here to keep matching free of a
// circular import on the booking package.
func indiaLoc() *time.Location {
	if loc, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return loc
	}
	return time.FixedZone("IST", 5*3600+30*60)
}
