// Package healthmetrics is an in-memory sliding-window collector for the CRM
// admin dashboard's health strip. Tracks request latency + status codes for
// the last N minutes (default 5). Thread-safe.
//
// Intentionally a non-persistent in-memory collector — the dashboard only
// needs short-term aggregates, not historical metrics. For real APM use
// Prometheus / OTel exporters separately.
package healthmetrics

import (
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
)

type sample struct {
	at         time.Time
	status     int
	durationMs int
}

type Collector struct {
	mu      sync.Mutex
	window  time.Duration
	samples []sample
}

func New(window time.Duration) *Collector {
	if window <= 0 {
		window = 5 * time.Minute
	}
	return &Collector{window: window}
}

// Middleware records the duration + status of each request.
func (c *Collector) Middleware() fiber.Handler {
	return func(ctx *fiber.Ctx) error {
		start := time.Now()
		err := ctx.Next()
		dur := time.Since(start)
		c.record(start, ctx.Response().StatusCode(), int(dur.Milliseconds()))
		return err
	}
}

func (c *Collector) record(at time.Time, status, durationMs int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cutoff := at.Add(-c.window)
	// Drop samples older than cutoff. Slice is roughly time-ordered so we
	// can drop from the front.
	drop := 0
	for drop < len(c.samples) && c.samples[drop].at.Before(cutoff) {
		drop++
	}
	if drop > 0 {
		c.samples = c.samples[drop:]
	}
	c.samples = append(c.samples, sample{at, status, durationMs})
}

// Snapshot returns aggregates over the configured window.
type Snapshot struct {
	AvgLatencyMS int     `json:"avg_latency_ms"`
	ErrorRate    float64 `json:"error_rate"` // 0.0–1.0
	RequestCount int     `json:"request_count"`
}

func (c *Collector) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	cutoff := time.Now().Add(-c.window)
	drop := 0
	for drop < len(c.samples) && c.samples[drop].at.Before(cutoff) {
		drop++
	}
	if drop > 0 {
		c.samples = c.samples[drop:]
	}
	if len(c.samples) == 0 {
		return Snapshot{}
	}
	var totalDur, errs int
	for _, s := range c.samples {
		totalDur += s.durationMs
		if s.status >= 500 {
			errs++
		}
	}
	n := len(c.samples)
	return Snapshot{
		AvgLatencyMS: totalDur / n,
		ErrorRate:    float64(errs) / float64(n),
		RequestCount: n,
	}
}
