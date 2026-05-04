package payments

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ConsumeOnce runs fn exactly once per event_id. The first delivery of an
// event_id executes fn and records it in processed_webhook_events; later
// deliveries observe the existing row and skip.
//
// Concurrency: two simultaneous deliveries of the same event_id can both pass
// the existence check and run fn. fn must therefore be idempotent on its own
// — this helper closes the duplicate-after-the-fact case (gateway retries),
// not the simultaneous-delivery case. The post-fn INSERT uses ON CONFLICT DO
// NOTHING so the second writer simply no-ops.
//
// Returns nil on duplicate; the fn's error otherwise.
func ConsumeOnce(ctx context.Context, db *pgxpool.Pool, eventID string, fn func(context.Context) error) error {
	if eventID == "" {
		return fmt.Errorf("payments.ConsumeOnce: empty event_id")
	}

	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	var processedAt time.Time
	err := db.QueryRow(checkCtx,
		`SELECT processed_at FROM processed_webhook_events WHERE event_id = $1`,
		eventID,
	).Scan(&processedAt)
	cancel()
	if err == nil {
		return nil // already processed
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("payments.ConsumeOnce: lookup failed: %w", err)
	}

	if err := fn(ctx); err != nil {
		return err
	}

	insertCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if _, err := db.Exec(insertCtx,
		`INSERT INTO processed_webhook_events (event_id) VALUES ($1)
		 ON CONFLICT (event_id) DO NOTHING`,
		eventID,
	); err != nil {
		return fmt.Errorf("payments.ConsumeOnce: mark processed failed: %w", err)
	}
	return nil
}
