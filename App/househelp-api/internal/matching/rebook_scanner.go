package matching

// RebookScanner — every-5-minute cron.
//
// Scans bookings cancelled by the dispatch crons (cancelled_by =
// 'no_pros_found') in the last 2 hours that haven't yet had the rebook
// nudge fired. For each, checks whether any pro is currently active in the
// same locality; if yes, fires a single "Pros are now available" data push
// and stamps rebook_pushed_at so the same booking never gets nagged twice.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// RebookScanner drives the per-5min sweep.
type RebookScanner struct {
	dispatcher *Dispatcher
}

// NewRebookScanner constructs one.
func NewRebookScanner(d *Dispatcher) *RebookScanner {
	return &RebookScanner{dispatcher: d}
}

// Start runs the sweep loop until ctx is cancelled.
func (r *RebookScanner) Start(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	tick := func() {
		pushed, err := r.RunOnce(ctx)
		if err != nil {
			log.Warn().Err(err).Msg("[rebook-scan] error")
			return
		}
		if pushed > 0 {
			log.Info().Int("pushed", pushed).Msg("[rebook-scan] sweep")
		}
	}

	tick() // immediate run on startup
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("[rebook-scan] ctx cancelled — exiting")
			return
		case <-ticker.C:
			tick()
		}
	}
}

// RunOnce performs a single sweep. Returns the number of pushes fired.
func (r *RebookScanner) RunOnce(ctx context.Context) (int, error) {
	pushed := 0
	for {
		if ctx.Err() != nil {
			return pushed, ctx.Err()
		}
		bookingID, customerID, locality, ok, err := r.claimNext(ctx)
		if err != nil {
			return pushed, err
		}
		if !ok {
			return pushed, nil
		}

		hasPro, err := r.localityHasActivePro(ctx, locality)
		if err != nil {
			log.Warn().Err(err).Str("booking_id", bookingID).Msg("[rebook-scan] locality probe failed")
			continue
		}
		if !hasPro {
			// Mark visited so we don't re-probe the same booking every 5 min.
			// The 2h lookback in claimNext also bounds the queue size.
			if _, err := r.dispatcher.db.Exec(ctx, `
				UPDATE bookings SET rebook_pushed_at = now()
				WHERE id = $1::uuid AND rebook_pushed_at IS NULL
			`, bookingID); err != nil {
				log.Warn().Err(err).Str("booking_id", bookingID).Msg("[rebook-scan] mark-visited exec failed")
			}
			continue
		}

		if r.dispatcher.notifications != nil {
			_ = r.dispatcher.notifications.SendData(ctx, customerID, map[string]string{
				"type":       "BOOKING_REBOOK_AVAILABLE",
				"booking_id": bookingID,
				"title":      "Pros are now available",
				"body":       "Pros are now available in your area. Tap to rebook your cancelled slot.",
			})
		}
		if _, err := r.dispatcher.db.Exec(ctx, `
			UPDATE bookings SET rebook_pushed_at = now()
			WHERE id = $1::uuid AND rebook_pushed_at IS NULL
		`, bookingID); err != nil {
			log.Warn().Err(err).Str("booking_id", bookingID).Msg("[rebook-scan] mark-pushed exec failed")
		}
		pushed++
	}
}

// claimNext picks the next eligible cancelled booking. SELECT FOR UPDATE
// SKIP LOCKED keeps multi-instance runs from doubling up the push.
func (r *RebookScanner) claimNext(ctx context.Context) (bookingID, customerID string, locality *string, ok bool, err error) {
	tx, err := r.dispatcher.db.Begin(ctx)
	if err != nil {
		return "", "", nil, false, err
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx, `
		SELECT id::text, customer_id::text, locality
		FROM bookings
		WHERE status              = 'cancelled'
		  AND cancelled_by        = 'no_pros_found'
		  AND invite_exhausted_at IS NOT NULL
		  AND invite_exhausted_at >= now() - interval '2 hours'
		  AND rebook_pushed_at    IS NULL
		ORDER BY invite_exhausted_at ASC
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`)
	if err := row.Scan(&bookingID, &customerID, &locality); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", nil, false, nil
		}
		return "", "", nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", nil, false, err
	}
	return bookingID, customerID, locality, true, nil
}

// localityHasActivePro returns true when at least one approved + non-banned
// pro in the given locality is currently online (helpers.is_available + a
// last_location_at heartbeat in the last 5 min). When locality is nil any
// active pro qualifies — keeps cancelled-booking nudges firing even when
// the original locality match was empty.
func (r *RebookScanner) localityHasActivePro(ctx context.Context, locality *string) (bool, error) {
	args := []any{}
	q := `
		SELECT EXISTS (
		    SELECT 1
		    FROM users u
		    JOIN helpers h ON h.id = u.id
		    WHERE u.role IN ('helper','pro')
		      AND u.deleted_at  IS NULL
		      AND u.banned_at   IS NULL
		      AND COALESCE(h.approval_status = 'approved', false)
		      AND h.is_available = true
		      AND h.last_location_at IS NOT NULL
		      AND h.last_location_at > now() - interval '5 minutes'
		`
	if locality != nil && *locality != "" {
		q += " AND h.locality ILIKE $1"
		args = append(args, *locality)
	}
	q += ")"

	var exists bool
	if err := r.dispatcher.db.QueryRow(ctx, q, args...).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}
