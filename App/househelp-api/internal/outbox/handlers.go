package outbox

import (
	"context"

	"github.com/rs/zerolog/log"
)

// NoopHandler logs receipt and marks the event done. Used for event types
// whose side-effects already fire via direct call paths (pre-outbox inline
// FCM calls). Keeps the table drained without triggering duplicate actions.
func NoopHandler(_ context.Context, row Row) error {
	log.Debug().
		Str("id", row.ID).
		Str("event_type", row.EventType).
		Str("aggregate_id", row.AggregateID).
		Int("attempt", row.AttemptCount).
		Msg("[outbox] no-op handler: marking done")
	return nil
}

// DefaultHandlers returns the handler registry for all currently-emitted
// event types. All handlers are no-ops because their side-effects already
// fire via direct FCM calls in payments/handler.go and wallet/service.go.
func DefaultHandlers() map[string]Handler {
	return map[string]Handler{
		"wallet.credited":  NoopHandler,
		"wallet.debited":   NoopHandler,
		"wallet.topped_up": NoopHandler,
		"booking.paid":     NoopHandler,
		"*":               NoopHandler,
	}
}
