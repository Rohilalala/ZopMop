package booking

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DBTX is an executor that can run SQL in a pool or active transaction.
type DBTX interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// OutboxRepository persists booking side-effect events in booking_outbox.
type OutboxRepository struct {
	db *pgxpool.Pool
}

// NewOutboxRepository creates a new outbox repository.
func NewOutboxRepository(db *pgxpool.Pool) *OutboxRepository {
	return &OutboxRepository{db: db}
}

// Enqueue inserts a pending outbox event using the provided executor.
func (r *OutboxRepository) Enqueue(ctx context.Context, exec DBTX, evt OutboxEvent) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rawPayload, err := evt.Payload.Marshal()
	if err != nil {
		return fmt.Errorf("marshal outbox payload: %w", err)
	}

	_, err = exec.Exec(queryCtx,
		`INSERT INTO booking_outbox (event_type, payload)
 VALUES ($1, $2::jsonb)`,
		evt.Type, rawPayload,
	)
	if err != nil {
		return fmt.Errorf("enqueue booking outbox event: %w", err)
	}

	return nil
}

// EnqueueWithRepositoryDB inserts an outbox event using the repository pool.
func (r *OutboxRepository) EnqueueWithRepositoryDB(ctx context.Context, evt OutboxEvent) error {
	return r.Enqueue(ctx, r.db, evt)
}
