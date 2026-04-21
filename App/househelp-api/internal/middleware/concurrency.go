package middleware

import (
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v2"
)

type dbConcurrencyState struct {
	semaphore chan struct{}

	maxInFlight int
	waitTimeout time.Duration

	currentQueued  atomic.Int64
	rejectedTotal  atomic.Int64
	acceptedTotal  atomic.Int64
	totalWaitNanos atomic.Int64
	waitSamples    atomic.Int64
}

var globalDBConcurrencyState atomic.Pointer[dbConcurrencyState]

// DBConcurrencyLimiter bounds DB-bound in-flight requests and fast-fails on saturation.
func DBConcurrencyLimiter(maxInFlight int, waitTimeout time.Duration) fiber.Handler {
	if maxInFlight <= 0 {
		maxInFlight = 600
	}
	if waitTimeout <= 0 {
		waitTimeout = 75 * time.Millisecond
	}

	state := &dbConcurrencyState{
		semaphore:   make(chan struct{}, maxInFlight),
		maxInFlight: maxInFlight,
		waitTimeout: waitTimeout,
	}
	globalDBConcurrencyState.Store(state)

	return func(c *fiber.Ctx) error {
		startWait := time.Now()

		select {
		case state.semaphore <- struct{}{}:
			state.acceptedTotal.Add(1)
			state.waitSamples.Add(1)
			state.totalWaitNanos.Add(time.Since(startWait).Nanoseconds())
			defer func() { <-state.semaphore }()
			return c.Next()
		default:
		}

		state.currentQueued.Add(1)
		defer state.currentQueued.Add(-1)

		timer := time.NewTimer(state.waitTimeout)
		defer timer.Stop()

		select {
		case state.semaphore <- struct{}{}:
			state.acceptedTotal.Add(1)
			state.waitSamples.Add(1)
			state.totalWaitNanos.Add(time.Since(startWait).Nanoseconds())
			defer func() { <-state.semaphore }()
			return c.Next()
		case <-timer.C:
			state.rejectedTotal.Add(1)
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"error": "server is busy, retry shortly",
			})
		}
	}
}

// DBConcurrencyMetrics exposes limiter saturation and wait metrics.
func DBConcurrencyMetrics() map[string]int64 {
	state := globalDBConcurrencyState.Load()
	if state == nil {
		return map[string]int64{}
	}

	waitSamples := state.waitSamples.Load()
	avgWaitMicros := int64(0)
	if waitSamples > 0 {
		avgWaitMicros = (state.totalWaitNanos.Load() / waitSamples) / int64(time.Microsecond)
	}

	return map[string]int64{
		"max_in_flight":         int64(state.maxInFlight),
		"wait_timeout_ms":       int64(state.waitTimeout / time.Millisecond),
		"in_flight_current":     int64(len(state.semaphore)),
		"queued_current":        state.currentQueued.Load(),
		"accepted_total":        state.acceptedTotal.Load(),
		"rejected_503_total":    state.rejectedTotal.Load(),
		"wait_samples_total":    waitSamples,
		"avg_queue_wait_micros": avgWaitMicros,
	}
}
