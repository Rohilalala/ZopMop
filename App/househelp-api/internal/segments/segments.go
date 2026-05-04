// Package segments computes lifecycle buckets for users based on their
// booking history. It runs as a background worker on a 24h cadence; consumers
// (CRM users list, growth lost-user campaigns) read the persisted column
// directly so the segment is consistent across reads within a day.
package segments

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Service holds the DB pool used for the segment-recompute job.
type Service struct{ db *pgxpool.Pool }

// NewService constructs a Service.
func NewService(db *pgxpool.Pool) *Service { return &Service{db: db} }

// Recompute runs a single bulk UPDATE that re-derives segment for every
// active user from their last completed booking. One statement keeps the
// runtime O(seq scan) instead of O(N round trips) at the user count.
//
// Buckets:
//   NEW       — zero completed bookings
//   RETURNING — last completed booking within the last 15 days
//   AT_RISK   — last completed 15-30 days ago
//   CHURNED   — last completed > 30 days ago
//
// Returns the number of rows touched (which is every active user; the value
// is mostly useful for log assertions in tests).
func (s *Service) Recompute(ctx context.Context) (int64, error) {
	tag, err := s.db.Exec(ctx, `
		UPDATE users u
		SET segment = sub.bucket
		FROM (
		  SELECT u.id,
		    CASE
		      WHEN MAX(b.completed_at) IS NULL                                       THEN 'NEW'
		      WHEN MAX(b.completed_at) >= now() - interval '15 days'                 THEN 'RETURNING'
		      WHEN MAX(b.completed_at) >= now() - interval '30 days'                 THEN 'AT_RISK'
		      ELSE                                                                       'CHURNED'
		    END AS bucket
		  FROM users u
		  LEFT JOIN bookings b ON b.customer_id = u.id AND b.status = 'completed'
		  WHERE u.deleted_at IS NULL
		  GROUP BY u.id
		) sub
		WHERE u.id = sub.id AND u.segment IS DISTINCT FROM sub.bucket
	`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// Worker drives Recompute on an interval. Defaults to 24h.
type Worker struct {
	svc      *Service
	interval time.Duration
	stop     chan struct{}
	wg       sync.WaitGroup
}

// NewWorker constructs a Worker. interval <=0 falls back to 24h.
func NewWorker(svc *Service, interval time.Duration) *Worker {
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	return &Worker{svc: svc, interval: interval, stop: make(chan struct{})}
}

// Start launches the goroutine. Runs once immediately so a fresh boot
// produces a usable segment column without waiting a full interval.
func (w *Worker) Start() {
	if w == nil || w.svc == nil {
		return
	}
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		w.runOnce()
		t := time.NewTicker(w.interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				w.runOnce()
			case <-w.stop:
				return
			}
		}
	}()
}

// Stop signals the goroutine and waits for it to exit.
func (w *Worker) Stop() {
	if w == nil {
		return
	}
	close(w.stop)
	w.wg.Wait()
}

func (w *Worker) runOnce() {
	if w == nil || w.svc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	n, err := w.svc.Recompute(ctx)
	if err != nil {
		log.Warn().Err(err).Msg("[segments] recompute failed")
		return
	}
	log.Info().Int64("rows_changed", n).Msg("[segments] recompute complete")
}
