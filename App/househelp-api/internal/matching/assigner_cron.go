package matching

// AssignerCron — the 60-second tick that drives the unified JIT assigner
// (spec §5.1). It replaces all three legacy dispatch crons (nightly 22:00
// ScheduledDispatcher, per-minute StealthDispatcher, 5-second batcher):
//
//   - Each tick drains every booking the assigner can claim (ClaimDue) and
//     tries to place it (AssignOne).
//   - A claimed booking with no eligible pro is left pending when it is still
//     BEFORE its scheduled_time — ClaimDue re-claims it next tick (its
//     matched_at goes stale after staleClaimAge), so the assigner keeps
//     retrying from T−lead right up to T+0.
//   - At or after scheduled_time with still no pro, the booking is terminal:
//     cancelled / cancelled_by='no_pros_found', customer push, refund-if-paid
//     (spec §5.5). The rebook scanner (kept) later nudges the customer when
//     pros return to the locality.
//
// The ASAP synchronous path (booking-creation request, Task 5) is the other
// AssignOne caller; this cron is the safety net for slot bookings and for an
// ASAP that crashed mid-create.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/wallet"
)

// assignerTickInterval is the cron cadence. 60 s matches spec §5.1; the
// staleClaimAge (55 s) is tuned just under it so a booking a tick claims but
// fails to place is re-claimable on the very next tick.
const assignerTickInterval = 60 * time.Second

// AssignerCron wraps an *Assigner with the loop, the terminal no-pro path, and
// the dependencies the terminal path needs (wallet repo for refunds, a
// Dispatcher for the shared cancel/push helpers).
type AssignerCron struct {
	asg        *Assigner
	walletRepo *wallet.Repository
	loc        *time.Location // IST for the customer-facing "when" copy
	cancel     context.CancelFunc
	done       chan struct{}
}

// NewAssignerCron constructs the cron driver. walletRepo may be nil to skip
// refund records (e.g. in tests that don't exercise paid bookings).
func NewAssignerCron(asg *Assigner, walletRepo *wallet.Repository) *AssignerCron {
	return &AssignerCron{asg: asg, walletRepo: walletRepo, loc: istLocation(), done: make(chan struct{})}
}

// Start runs the tick loop until ctx is cancelled (or Stop is called). Safe to
// call on a goroutine. Calling Start a second time is a no-op. The cron is the
// most important background worker — its no-pro terminal path performs the
// cancel + auto-refund DB transaction — so it exposes Stop for a clean drain on
// SIGTERM (audit NEW-B1-001 pattern), letting an in-flight tick finish.
func (c *AssignerCron) Start(parent context.Context) {
	if c.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	c.cancel = cancel

	go func() {
		defer close(c.done)

		ticker := time.NewTicker(assignerTickInterval)
		defer ticker.Stop()

		tick := func() {
			assigned, cancelled, err := c.RunOnce(ctx)
			if err != nil && !errors.Is(err, context.Canceled) {
				log.Warn().Err(err).Msg("[assigner-cron] tick error")
				return
			}
			if assigned > 0 || cancelled > 0 {
				log.Info().Int("assigned", assigned).Int("cancelled", cancelled).Msg("[assigner-cron] tick")
			}
		}

		tick() // immediate first run on startup (catch-up after a restart)
		for {
			select {
			case <-ctx.Done():
				log.Info().Msg("[assigner-cron] ctx cancelled — exiting")
				return
			case <-ticker.C:
				tick()
			}
		}
	}()
}

// Stop cancels the cron and waits for the current tick to drain, or for ctx to
// fire, whichever comes first. A no-op if Start was never called.
func (c *AssignerCron) Stop(ctx context.Context) error {
	if c.cancel == nil {
		return nil
	}
	c.cancel()
	select {
	case <-c.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// RunOnce drains every claimable booking once. For each: AssignOne, and on
// ErrNoEligiblePro decide retry-vs-terminal by the slot clock. Returns the
// number assigned and the number terminally cancelled this pass.
func (c *AssignerCron) RunOnce(ctx context.Context) (assigned, cancelled int, err error) {
	for {
		if ctx.Err() != nil {
			return assigned, cancelled, ctx.Err()
		}
		bookingID, ok, claimErr := c.asg.ClaimDue(ctx)
		if claimErr != nil {
			return assigned, cancelled, claimErr
		}
		if !ok {
			return assigned, cancelled, nil // nothing due
		}

		// AssignOne reads bookings.excluded_pro_id itself (migration 135), so a pro
		// that just cancelled or declared leave isn't immediately re-offered the
		// same booking. The cron passes "" — the persisted column is the source of
		// truth for re-dispatch exclusion (spec §7).
		_, aErr := c.asg.AssignOne(ctx, bookingID, "")
		switch {
		case aErr == nil:
			assigned++
		case errors.Is(aErr, ErrAlreadyClaimed):
			// Another writer (admin assign, racing ASAP attempt) won it — fine.
		case errors.Is(aErr, ErrNoEligiblePro):
			done, tErr := c.handleNoPro(ctx, bookingID)
			if tErr != nil {
				log.Warn().Err(tErr).Str("booking_id", bookingID).Msg("[assigner-cron] no-pro handling failed")
				continue
			}
			if done {
				cancelled++
			}
			// not done → before slot start; leave pending, ClaimDue retries it.
		default:
			log.Warn().Err(aErr).Str("booking_id", bookingID).Msg("[assigner-cron] assign error")
		}
	}
}

// handleNoPro decides what to do with a claimed booking that found no eligible
// pro. Before its scheduled_time it stays pending (done=false → retried next
// tick). At/after scheduled_time it is terminal (done=true): cancel +
// no-pros-found push + refund-if-paid, all in one transaction.
func (c *AssignerCron) handleNoPro(ctx context.Context, bookingID string) (done bool, err error) {
	tx, err := c.asg.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	var (
		customerID    string
		scheduledTime time.Time
		paymentMethod *string
		paymentID     *string
		paymentStatus *string
		amountPaise   int64
		discountPaise int64
	)
	// Re-load + lock the row. SKIP LOCKED keeps a parallel writer (admin assign)
	// from blocking us, and the status guard means an assign that landed between
	// AssignOne and here leaves the row untouched.
	err = tx.QueryRow(ctx, `
		SELECT customer_id::text, scheduled_time,
		       payment_method, payment_id, payment_status,
		       amount_paise, COALESCE(discount_paise, 0)
		FROM bookings
		WHERE id = $1::uuid
		  AND status = 'pending'
		  AND helper_id IS NULL
		FOR UPDATE SKIP LOCKED
	`, bookingID).Scan(&customerID, &scheduledTime,
		&paymentMethod, &paymentID, &paymentStatus, &amountPaise, &discountPaise)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Row was assigned / cancelled out from under us — nothing to do.
			return false, nil
		}
		return false, err
	}

	// Before the slot starts → not terminal yet. Leave pending; the stale
	// matched_at re-claim retries it next tick (right up to scheduled_time).
	if time.Now().Before(scheduledTime) {
		return false, nil
	}

	if _, err := tx.Exec(ctx, `
		UPDATE bookings
		SET status              = 'cancelled',
		    cancelled_by        = 'no_pros_found',
		    invite_exhausted_at = now(),
		    cancelled_at        = now(),
		    updated_at          = now()
		WHERE id = $1::uuid
	`, bookingID); err != nil {
		return false, err
	}

	// Refund-if-paid via the shared booking rail (wallet credit or
	// pending_refunds), in the same tx as the cancel.
	if c.walletRepo != nil {
		refundAmount := amountPaise - discountPaise
		if err := wallet.RecordBookingRefundTx(ctx, tx, c.walletRepo, customerID, bookingID,
			paymentMethod, paymentID, paymentStatus, refundAmount,
			"Auto-refunded: no pro available at slot time"); err != nil {
			return false, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return false, err
	}

	// Best-effort customer push after commit, via the shared dispatch helper.
	d := &Dispatcher{db: c.asg.db, notifications: dataNotifier{c.asg.notifications}}
	when := scheduledTime.In(c.loc).Format("Mon Jan 2 3:04 PM")
	d.pushCustomerNoProsFound(ctx, customerID, bookingID, when)
	return true, nil
}
