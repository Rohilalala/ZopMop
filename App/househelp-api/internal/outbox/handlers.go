package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// NoopHandler logs receipt and marks the event done.
func NoopHandler(_ context.Context, row Row) error {
	log.Debug().
		Str("id", row.ID).
		Str("event_type", row.EventType).
		Str("aggregate_id", row.AggregateID).
		Int("attempt", row.AttemptCount).
		Msg("[outbox] no-op handler: marking done")
	return nil
}

// bookingNotifier is the subset of notification.Service used by booking handlers.
type bookingNotifier interface {
	NotifyProBookingCancelled(ctx context.Context, helperID, bookingID string) error
	NotifyCustomerBookingAccepted(ctx context.Context, customerID, helperName, bookingID string) error
	NotifyCustomerBookingCompleted(ctx context.Context, customerID, bookingID string) error
}

// BookingHandlers returns handlers for booking lifecycle events that fire FCM
// notifications via the transactional outbox (durable, retried on failure).
func BookingHandlers(notif bookingNotifier, db *pgxpool.Pool) map[string]Handler {
	return map[string]Handler{
		"booking.cancelled": func(ctx context.Context, row Row) error {
			var p struct {
				BookingID string `json:"booking_id"`
				HelperID  string `json:"helper_id"`
			}
			if err := json.Unmarshal(row.Payload, &p); err != nil {
				return fmt.Errorf("booking.cancelled: unmarshal: %w", err)
			}
			if p.HelperID == "" {
				return nil
			}
			return notif.NotifyProBookingCancelled(ctx, p.HelperID, p.BookingID)
		},

		"booking.accepted": func(ctx context.Context, row Row) error {
			var p struct {
				BookingID  string `json:"booking_id"`
				CustomerID string `json:"customer_id"`
				HelperID   string `json:"helper_id"`
			}
			if err := json.Unmarshal(row.Payload, &p); err != nil {
				return fmt.Errorf("booking.accepted: unmarshal: %w", err)
			}
			// Resolve helper name from DB for the "X is on their way" message.
			// Helper display names live in users.name (helpers.id IS users.id —
			// helpers extend users via a shared PK); the helpers table has no
			// name column. Mirror matching/dispatch.go:helperName.
			var helperName string
			if err := db.QueryRow(ctx,
				`SELECT COALESCE(name, '') FROM users WHERE id = $1 AND deleted_at IS NULL`, p.HelperID,
			).Scan(&helperName); err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("booking.accepted: lookup helper name: %w", err)
				}
				helperName = ""
			}
			if helperName == "" {
				helperName = "Your pro"
			}
			return notif.NotifyCustomerBookingAccepted(ctx, p.CustomerID, helperName, p.BookingID)
		},

		"booking.completed": func(ctx context.Context, row Row) error {
			var p struct {
				BookingID  string `json:"booking_id"`
				CustomerID string `json:"customer_id"`
			}
			if err := json.Unmarshal(row.Payload, &p); err != nil {
				return fmt.Errorf("booking.completed: unmarshal: %w", err)
			}
			return notif.NotifyCustomerBookingCompleted(ctx, p.CustomerID, p.BookingID)
		},
	}
}

// DefaultHandlers returns the handler registry for wallet/payment events
// whose side-effects fire via direct call paths (pre-outbox inline FCM calls).
func DefaultHandlers() map[string]Handler {
	return map[string]Handler{
		"wallet.credited":  NoopHandler,
		"wallet.debited":   NoopHandler,
		"wallet.topped_up": NoopHandler,
		"booking.paid":     NoopHandler,
		"*":               NoopHandler,
	}
}
