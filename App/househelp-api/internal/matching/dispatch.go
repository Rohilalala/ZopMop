package matching

// Shared dispatch infrastructure.
//
// The offer/accept invite chain and its two cron drivers (nightly
// ScheduledDispatcher, per-minute StealthDispatcher) were retired by the
// unified JIT assigner (spec §9). What remains here is the small set of
// shared helpers the assigner cron and the RebookScanner still lean on:
// the Dispatcher bundle (db + notifier), booking loaders, the no-pros
// terminal transition, and the customer-facing push helpers.

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/adityarohilla/househelp-api/internal/users"
)

// expertsLookup is the (small) interface the assigner needs from the experts
// package. Implemented by *experts.Service. Kept as an interface so this
// package doesn't depend on the experts package directly (avoids the import
// cycle that would happen once experts grows to depend on matching).
type expertsLookup interface {
	PreferredHelperIDs(ctx context.Context, userID string) ([]string, error)
}

// notifier is the subset of *notification.Service we need. Defined as an
// interface for testability.
type notifier interface {
	SendData(ctx context.Context, userID string, data map[string]string) error
}

// Dispatcher bundles the shared dependencies of the surviving cron drivers
// (assigner no-pro path, RebookScanner).
type Dispatcher struct {
	db            *pgxpool.Pool
	rdb           *redis.Client
	notifications notifier
	experts       expertsLookup
}

// NewDispatcher constructs a Dispatcher. Pass nil notifications to no-op the
// FCM side (handy in tests).
func NewDispatcher(db *pgxpool.Pool, rdb *redis.Client, notif notifier, exp expertsLookup) *Dispatcher {
	return &Dispatcher{db: db, rdb: rdb, notifications: notif, experts: exp}
}

// scheduledBookingRow is the projection loadBooking returns.
type scheduledBookingRow struct {
	ID                 string
	CustomerID         string
	ScheduledTime      time.Time
	DurationMinutes    int
	Locality           *string
	PreferredExhausted bool
}

// loadBooking fetches just enough of a booking row to drive dispatch decisions.
// Returns sql.ErrNoRows wrapped if the booking vanished mid-cron.
func (d *Dispatcher) loadBooking(ctx context.Context, bookingID string) (*scheduledBookingRow, error) {
	row := &scheduledBookingRow{}
	var locality *string
	err := d.db.QueryRow(ctx, `
		SELECT id::text, customer_id::text, scheduled_time,
		       COALESCE(total_duration_minutes, 60),
		       locality,
		       preferred_helper_chain_exhausted
		FROM bookings
		WHERE id = $1::uuid
	`, bookingID).Scan(
		&row.ID, &row.CustomerID, &row.ScheduledTime, &row.DurationMinutes,
		&locality, &row.PreferredExhausted,
	)
	if err != nil {
		return nil, err
	}
	row.Locality = locality
	return row, nil
}

// markBookingNoProsFound transitions a booking into the no-pros-found state.
// Sets cancelled, cancelled_by, invite_exhausted_at.
func (d *Dispatcher) markBookingNoProsFound(ctx context.Context, bookingID string) error {
	_, err := d.db.Exec(ctx, `
		UPDATE bookings
		SET status              = 'cancelled',
		    cancelled_by        = 'no_pros_found',
		    invite_exhausted_at = now(),
		    updated_at          = now()
		WHERE id     = $1::uuid
		  AND status IN ('pending','searching')
	`, bookingID)
	return err
}

// pushCustomerNoProsFound is the customer-facing "we couldn't find a pro"
// notification. Single-shot — fired by the cron driver immediately after the
// booking is cancelled.
func (d *Dispatcher) pushCustomerNoProsFound(ctx context.Context, customerID, bookingID, when string) {
	if d.notifications == nil {
		return
	}
	body := fmt.Sprintf("We couldn't find a pro for your %s booking. Tap to try booking again.", when)
	_ = d.notifications.SendData(ctx, customerID, map[string]string{
		"type":       "BOOKING_NO_PROS_FOUND",
		"booking_id": bookingID,
		"title":      "Booking unfilled",
		"body":       body,
	})
}

// pushCustomerAccepted notifies the customer that someone accepted. The
// assigner uses helperName + a slightly different body when the accepter was a
// preferred ("expert") pro.
func (d *Dispatcher) pushCustomerAccepted(ctx context.Context, customerID, bookingID, helperName string, fromPreferred bool) {
	if d.notifications == nil {
		return
	}
	title := "Booking confirmed"
	body := fmt.Sprintf("%s has accepted your booking.", helperName)
	if fromPreferred {
		title = "Your expert is on it"
		body = fmt.Sprintf("Your expert %s has accepted your booking.", helperName)
	}
	_ = d.notifications.SendData(ctx, customerID, map[string]string{
		"type":       "BOOKING_ACCEPTED",
		"booking_id": bookingID,
		"helper_name": helperName,
		"title":       title,
		"body":        body,
	})
}

// helperName fetches the display name of the assigned helper for the
// customer-facing acceptance push. Returns "Your pro" on lookup failure so
// the push always has a meaningful subject.
func (d *Dispatcher) helperName(ctx context.Context, helperID string) string {
	var name string
	err := d.db.QueryRow(ctx, `SELECT COALESCE(name, '') FROM users WHERE id = $1::uuid AND `+users.AliveCondition, helperID).Scan(&name)
	if err != nil || name == "" {
		return "Your pro"
	}
	return name
}
