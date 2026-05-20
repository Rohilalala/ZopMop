package payroll

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

// Cron drives the cycle-close payroll run. It fires once per day at
// 01:00 IST; the handler checks whether today is a cycle close
// date (the 15th or last-of-month) and only then runs.
//
// On boot, if the API started after 01:00 today and today is a
// close date, the cron replays the cycle once so a restart in the
// morning does not leave the day un-paid. Replays are safe because
// UpsertPayout uses ON CONFLICT DO NOTHING.
type Cron struct {
	svc    *Service
	stopCh chan struct{}
	wg     sync.WaitGroup
}

func NewCron(svc *Service) *Cron {
	return &Cron{svc: svc, stopCh: make(chan struct{})}
}

// Start launches the goroutine. Safe to call once.
func (c *Cron) Start(ctx context.Context) {
	c.wg.Add(1)
	go c.run(ctx)
	log.Info().Msg("[payroll] cron started (01:00 IST on 15th + last-of-month)")
}

// Stop signals the goroutine and waits for it to drain.
func (c *Cron) Stop() {
	close(c.stopCh)
	c.wg.Wait()
}

func (c *Cron) run(ctx context.Context) {
	defer c.wg.Done()

	// Boot replay: if today is a close date and we started after
	// 01:00, run now so a missed window does not skip a cycle.
	now := IST()
	oneAM := time.Date(now.Year(), now.Month(), now.Day(), 1, 0, 0, 0, istLocation)
	if now.After(oneAM) && IsCycleCloseDate(now) {
		c.runOnce(ctx)
	}

	for {
		next := NextCloseAfter(IST())
		wait := time.Until(next.In(time.Local))
		log.Info().Time("next_payroll_run", next).Dur("wait", wait).Msg("[payroll] scheduling next cycle close")
		select {
		case <-time.After(wait):
			c.runOnce(ctx)
		case <-c.stopCh:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (c *Cron) runOnce(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	defer cancel()
	if _, err := c.svc.RunForToday(ctx); err != nil {
		if err == ErrNotCycleClose {
			// Boot replay can race: someone runs the binary at
			// 01:30 IST on the 14th. Not an error, just a no-op.
			log.Debug().Msg("[payroll] runOnce: not a cycle close, skipping")
			return
		}
		log.Error().Err(err).Msg("[payroll] runOnce failed")
	}
}
