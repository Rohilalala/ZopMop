package reengagement

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

type processor interface {
	ProcessMoppingDropoff(ctx context.Context, now time.Time) error
	ProcessCartAbandonment(ctx context.Context, now time.Time) error
}

type Worker struct {
	svc      processor
	interval time.Duration
	stop     chan struct{}
	wg       sync.WaitGroup
}

func NewWorker(svc processor, interval time.Duration) *Worker {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	return &Worker{
		svc:      svc,
		interval: interval,
		stop:     make(chan struct{}),
	}
}

func (w *Worker) Start() {
	if w == nil || w.svc == nil {
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
	now := time.Now().UTC()
	if err := w.svc.ProcessMoppingDropoff(context.Background(), now); err != nil {
		log.Warn().Err(err).Msg("[reengagement] mopping dropoff processing failed")
	}
	if err := w.svc.ProcessCartAbandonment(context.Background(), now); err != nil {
		log.Warn().Err(err).Msg("[reengagement] cart abandonment processing failed")
	}
}
