package outbox

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

const (
	maxAttempts = 10
	claimLimit  = 100
	defaultTick = 5 * time.Second
	maxBackoff  = time.Hour
)

// Row is a single event_outbox record returned by the claim query.
type Row struct {
	ID           string
	EventType    string
	Version      string
	AggregateID  string
	Payload      []byte
	AttemptCount int
}

// Handler processes one outbox row. Return nil to mark done; return an error
// to trigger retry (or terminal failure after maxAttempts).
type Handler func(ctx context.Context, row Row) error

// Worker polls event_outbox and dispatches events to registered handlers.
type Worker struct {
	db       *pgxpool.Pool
	handlers map[string]Handler
	interval time.Duration
	stop     chan struct{}
	wg       sync.WaitGroup
}

// NewWorker constructs a Worker. interval defaults to 5s if zero.
func NewWorker(db *pgxpool.Pool, interval time.Duration) *Worker {
	if interval <= 0 {
		interval = defaultTick
	}
	return &Worker{
		db:       db,
		handlers: make(map[string]Handler),
		interval: interval,
		stop:     make(chan struct{}),
	}
}

// Register adds a handler for an event_type. Call before Start.
// "*" is a catch-all used when no specific handler is registered.
func (w *Worker) Register(eventType string, h Handler) {
	w.handlers[eventType] = h
}

// Start launches the background polling goroutine.
func (w *Worker) Start() {
	if w == nil || w.db == nil {
		return
	}
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		w.runOnce()
		ticker := time.NewTicker(w.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				w.runOnce()
			case <-w.stop:
				return
			}
		}
	}()
}

// Stop signals the worker to shut down and waits for the current tick to finish.
func (w *Worker) Stop() {
	if w == nil {
		return
	}
	close(w.stop)
	w.wg.Wait()
}

func (w *Worker) runOnce() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rows, err := w.claim(ctx)
	if err != nil {
		log.Warn().Err(err).Msg("[outbox] claim failed")
		return
	}
	if len(rows) == 0 {
		return
	}

	for _, row := range rows {
		if err := w.dispatch(ctx, row); err != nil {
			log.Warn().Err(err).Str("id", row.ID).Str("event_type", row.EventType).Msg("[outbox] dispatch failed")
		}
	}
}

// claim atomically marks up to claimLimit pending rows as 'processing'
// and returns them. Uses FOR UPDATE SKIP LOCKED so multiple instances
// never race on the same row.
func (w *Worker) claim(ctx context.Context) ([]Row, error) {
	pgRows, err := w.db.Query(ctx, `
		WITH claimed AS (
			UPDATE event_outbox
			SET    status        = 'processing',
			       attempt_count = attempt_count + 1,
			       updated_at    = NOW()
			WHERE id IN (
				SELECT id
				FROM   event_outbox
				WHERE  status       = 'pending'
				  AND  available_at <= NOW()
				ORDER  BY created_at
				LIMIT  $1
				FOR UPDATE SKIP LOCKED
			)
			RETURNING id, event_type, version, aggregate_id, payload, attempt_count
		)
		SELECT id::text, event_type, version, aggregate_id::text, payload, attempt_count
		FROM   claimed
	`, claimLimit)
	if err != nil {
		return nil, fmt.Errorf("claim query: %w", err)
	}
	defer pgRows.Close()

	var out []Row
	for pgRows.Next() {
		var r Row
		if err := pgRows.Scan(&r.ID, &r.EventType, &r.Version, &r.AggregateID, &r.Payload, &r.AttemptCount); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out = append(out, r)
	}
	return out, pgRows.Err()
}

// dispatch calls the registered handler and writes the outcome back.
func (w *Worker) dispatch(ctx context.Context, row Row) error {
	h, ok := w.handlers[row.EventType]
	if !ok {
		h = w.handlers["*"] // catch-all
	}

	var handlerErr error
	if h != nil {
		handlerErr = h(ctx, row)
	}

	if handlerErr == nil {
		return w.markDone(ctx, row.ID)
	}

	if row.AttemptCount >= maxAttempts {
		return w.markFailed(ctx, row.ID, handlerErr.Error())
	}
	return w.markRetry(ctx, row.ID, handlerErr.Error(), row.AttemptCount)
}

func (w *Worker) markDone(ctx context.Context, id string) error {
	_, err := w.db.Exec(ctx, `
		UPDATE event_outbox
		SET status = 'done', done_at = NOW(), updated_at = NOW()
		WHERE id = $1::uuid
	`, id)
	return err
}

func (w *Worker) markFailed(ctx context.Context, id, errMsg string) error {
	log.Error().Str("id", id).Str("error", errMsg).Msg("[outbox] event reached max attempts, marking failed")
	_, err := w.db.Exec(ctx, `
		UPDATE event_outbox
		SET status = 'failed', last_error = $2, updated_at = NOW()
		WHERE id = $1::uuid
	`, id, errMsg)
	return err
}

func (w *Worker) markRetry(ctx context.Context, id, errMsg string, attempt int) error {
	backoff := backoffDuration(attempt)
	_, err := w.db.Exec(ctx, `
		UPDATE event_outbox
		SET    status       = 'pending',
		       last_error   = $2,
		       available_at = NOW() + $3::interval,
		       updated_at   = NOW()
		WHERE  id = $1::uuid
	`, id, errMsg, backoff.String())
	return err
}

// backoffDuration returns exponential backoff: 5s * attempt^2, capped at 1h.
func backoffDuration(attempt int) time.Duration {
	secs := math.Pow(float64(attempt), 2) * 5
	d := time.Duration(secs) * time.Second
	if d > maxBackoff {
		d = maxBackoff
	}
	if d < 5*time.Second {
		d = 5 * time.Second
	}
	return d
}
