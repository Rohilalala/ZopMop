package analytics

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

type RollupWorker struct {
	repo     *Repository
	interval time.Duration

	stop chan struct{}
	wg   sync.WaitGroup

	lastSuccessUnix atomic.Int64
	runFailures     atomic.Int64
}

func NewRollupWorker(db *pgxpool.Pool, interval time.Duration) *RollupWorker {
	if interval <= 0 {
		interval = time.Minute
	}
	return &RollupWorker{
		repo:     NewRepository(db),
		interval: interval,
		stop:     make(chan struct{}),
	}
}

func (w *RollupWorker) Start() {
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

func (w *RollupWorker) Stop() {
	close(w.stop)
	w.wg.Wait()
}

func (w *RollupWorker) runOnce() {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	if err := w.repo.RefreshRollups(ctx); err != nil {
		w.runFailures.Add(1)
		log.Warn().Err(err).Msg("[analytics] rollup refresh failed")
		return
	}

	w.lastSuccessUnix.Store(time.Now().Unix())
}

func (w *RollupWorker) Metrics() map[string]int64 {
	return map[string]int64{
		"last_success_unix":  w.lastSuccessUnix.Load(),
		"run_failures_total": w.runFailures.Load(),
		"interval_seconds":   int64(w.interval / time.Second),
	}
}
