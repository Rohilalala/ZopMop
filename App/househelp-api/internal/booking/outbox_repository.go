package booking

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DBTX is an executor that can run SQL in a pool or active transaction.
type DBTX interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

type OutboxPendingEvent struct {
	ID           string
	Type         BookingOutboxEventType
	Payload      BookingOutboxPayload
	AttemptCount int
}

type OutboxMetrics struct {
	Pending         int64   `json:"pending"`
	Processing      int64   `json:"processing"`
	Failed          int64   `json:"failed"`
	AvgAttemptCount float64 `json:"avg_attempt_count"`
}

// OutboxRepository persists booking side-effect events in booking_outbox.
type OutboxRepository struct {
	db            *pgxpool.Pool
	leaseDuration time.Duration
}

// NewOutboxRepository creates a new outbox repository.
func NewOutboxRepository(db *pgxpool.Pool) *OutboxRepository {
	return &OutboxRepository{
		db:            db,
		leaseDuration: 5 * time.Minute,
	}
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

func (r *OutboxRepository) ClaimPending(ctx context.Context, limit int) ([]OutboxPendingEvent, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	leaseMs := r.processingLease().Milliseconds()
	rows, err := r.db.Query(queryCtx, `
WITH candidates AS (
	SELECT id
	FROM booking_outbox
	WHERE (
		(status = 'pending' AND available_at <= NOW())
		OR
		(status = 'processing' AND available_at <= NOW())
	)
	ORDER BY created_at ASC
	LIMIT $1
	FOR UPDATE SKIP LOCKED
)
UPDATE booking_outbox bo
SET status = 'processing',
	attempt_count = bo.attempt_count + 1,
	available_at = NOW() + (($2::bigint * INTERVAL '1 millisecond')),
	updated_at = NOW()
FROM candidates c
WHERE bo.id = c.id
RETURNING bo.id::text, bo.event_type, bo.payload, bo.attempt_count
`, limit, leaseMs)
	if err != nil {
		return nil, fmt.Errorf("claim pending outbox events: %w", err)
	}
	defer rows.Close()

	events := make([]OutboxPendingEvent, 0, limit)
	for rows.Next() {
		var evt OutboxPendingEvent
		var rawPayload []byte
		if err := rows.Scan(&evt.ID, &evt.Type, &rawPayload, &evt.AttemptCount); err != nil {
			return nil, fmt.Errorf("scan claimed outbox event: %w", err)
		}
		payload, err := UnmarshalBookingOutboxPayload(rawPayload)
		if err != nil {
			return nil, fmt.Errorf("decode claimed outbox payload: %w", err)
		}
		evt.Payload = payload
		events = append(events, evt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate claimed outbox events: %w", err)
	}

	return events, nil
}

func (r *OutboxRepository) processingLease() time.Duration {
	if r.leaseDuration > 0 {
		return r.leaseDuration
	}
	return 5 * time.Minute
}

func (r *OutboxRepository) MarkDone(ctx context.Context, eventID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx, `
UPDATE booking_outbox
SET status = 'done',
	last_error = NULL,
	updated_at = NOW()
WHERE id = $1
`, eventID)
	if err != nil {
		return fmt.Errorf("mark outbox event done: %w", err)
	}
	return nil
}

func (r *OutboxRepository) MarkRetry(ctx context.Context, eventID, lastError string, nextAvailableAt time.Time) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx, `
UPDATE booking_outbox
SET status = 'pending',
	available_at = $2,
	last_error = $3,
	updated_at = NOW()
WHERE id = $1
`, eventID, nextAvailableAt, lastError)
	if err != nil {
		return fmt.Errorf("mark outbox event retry: %w", err)
	}
	return nil
}

func (r *OutboxRepository) MarkFailed(ctx context.Context, eventID, lastError string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx, `
UPDATE booking_outbox
SET status = 'failed',
	available_at = NOW(),
	last_error = $2,
	updated_at = NOW()
WHERE id = $1
`, eventID, lastError)
	if err != nil {
		return fmt.Errorf("mark outbox event failed: %w", err)
	}
	return nil
}

func (r *OutboxRepository) Metrics(ctx context.Context) (OutboxMetrics, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var metrics OutboxMetrics
	err := r.db.QueryRow(queryCtx, `
SELECT
	COUNT(*) FILTER (WHERE status = 'pending')::bigint   AS pending,
	COUNT(*) FILTER (WHERE status = 'processing')::bigint AS processing,
	COUNT(*) FILTER (WHERE status = 'failed')::bigint    AS failed,
	COALESCE(AVG(attempt_count)::double precision, 0)    AS avg_attempt_count
FROM booking_outbox
`).Scan(&metrics.Pending, &metrics.Processing, &metrics.Failed, &metrics.AvgAttemptCount)
	if err != nil {
		return OutboxMetrics{}, fmt.Errorf("load outbox metrics: %w", err)
	}
	return metrics, nil
}

var _ DBTX = (pgx.Tx)(nil)
