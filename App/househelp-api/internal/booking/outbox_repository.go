package booking

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// OutboxRepository persists booking side-effect events in booking_outbox.
type OutboxRepository struct {
	db *pgxpool.Pool
}

// NewOutboxRepository creates a new outbox repository.
func NewOutboxRepository(db *pgxpool.Pool) *OutboxRepository {
	return &OutboxRepository{db: db}
}

// Enqueue inserts a pending outbox event.
func (r *OutboxRepository) Enqueue(ctx context.Context, eventType BookingOutboxEventType, payload BookingOutboxPayload) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rawPayload, err := payload.Marshal()
	if err != nil {
		return fmt.Errorf("marshal outbox payload: %w", err)
	}

	_, err = r.db.Exec(queryCtx,
		`INSERT INTO booking_outbox (event_type, payload)
 VALUES ($1, $2::jsonb)`,
		eventType, rawPayload,
	)
	if err != nil {
		return fmt.Errorf("enqueue booking outbox event: %w", err)
	}

	return nil
}
