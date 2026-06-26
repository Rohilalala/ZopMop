package shift

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

// Cron drives the scheduled shift-system jobs. Three loops:
//
//   - 03:00 IST daily      → LockShiftsAt3AM
//   - every 60 minutes      → RecomputeCancellationCount30d
//   - every 60 seconds      → force-offline expired shift sessions
//
// All loops run in the API process — no external scheduler. Each
// loop respects the context passed to Start; Stop cancels everything
// and waits for graceful exit.
type Cron struct {
	svc       *Service
	stopCh    chan struct{}
	wg        sync.WaitGroup
	startedAt time.Time
}

func NewCron(svc *Service) *Cron {
	return &Cron{svc: svc, stopCh: make(chan struct{})}
}

func (c *Cron) Start(ctx context.Context) {
	c.startedAt = time.Now()
	c.wg.Add(3)
	go c.runDaily3AM(ctx)
	go c.runHourly(ctx)
	go c.runSessionExpiry(ctx)
	log.Info().Msg("[shift] cron started (3AM lock, hourly recompute, 60s session-expiry sweep)")
}

func (c *Cron) Stop() {
	close(c.stopCh)
	c.wg.Wait()
}

// runDaily3AM fires once per day at 03:00 IST. Sleeps until the next
// occurrence; on wake it runs LockShiftsAt3AM with a fresh context.
// If the API restarts at 03:05, the next run is tomorrow — that's
// OK: LockShiftsAt3AM is idempotent and the on-boot replay below
// handles the missed window.
func (c *Cron) runDaily3AM(ctx context.Context) {
	defer c.wg.Done()

	// On boot, if we started after 03:00 today, replay the lock pass
	// so a restart in the morning doesn't leave today unlocked.
	now := IST()
	threeAM := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, istLocation)
	if now.After(threeAM) {
		c.runLock(ctx)
	}

	for {
		next := nextDailyAt(IST(), 3, 0)
		wait := time.Until(next.In(time.Local))
		log.Info().Time("next_3am_run", next).Dur("wait", wait).Msg("[shift] scheduling 3 AM lock")
		select {
		case <-time.After(wait):
			c.runLock(ctx)
		case <-c.stopCh:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (c *Cron) runLock(ctx context.Context) {
	jobCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := c.svc.LockShiftsAt3AM(jobCtx); err != nil {
		log.Error().Err(err).Msg("[shift] LockShiftsAt3AM failed")
		return
	}
	log.Info().Msg("[shift] 3 AM lock pass complete")
}

func (c *Cron) runHourly(ctx context.Context) {
	defer c.wg.Done()
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			jobCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := c.svc.repo.RecomputeCancellationCount30d(jobCtx); err != nil {
				log.Warn().Err(err).Msg("[shift] RecomputeCancellationCount30d failed")
			}
			cancel()
		case <-c.stopCh:
			return
		case <-ctx.Done():
			return
		}
	}
}

// runSessionExpiry force-closes shift sessions whose committed window has
// ended but the pro never went offline (the "online all day" bug). Runs every
// 60 seconds; each tick is best-effort and idempotent.
func (c *Cron) runSessionExpiry(ctx context.Context) {
	defer c.wg.Done()
	tick := time.NewTicker(60 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			jobCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if closed, err := c.svc.ExpireStaleSessions(jobCtx); err != nil {
				log.Warn().Err(err).Msg("[shift] ExpireStaleSessions sweep failed")
			} else if closed > 0 {
				log.Info().Int("closed", closed).Msg("[shift] force-offlined expired shift sessions")
			}
			cancel()
		case <-c.stopCh:
			return
		case <-ctx.Done():
			return
		}
	}
}

// nextDailyAt returns the next time-of-day occurrence at h:m in IST,
// after the given anchor.
func nextDailyAt(anchor time.Time, h, m int) time.Time {
	candidate := time.Date(anchor.Year(), anchor.Month(), anchor.Day(), h, m, 0, 0, istLocation)
	if !candidate.After(anchor) {
		candidate = candidate.AddDate(0, 0, 1)
	}
	return candidate
}
