package middleware

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// DefaultRequestTimeout is the per-request deadline applied to every route.
// 12s leaves headroom for slow database queries while still bounding the
// worst-case response time the client sees.
const DefaultRequestTimeout = 12 * time.Second

// Timeout returns a Fiber middleware that:
//   1. Sets a deadline-bound context.Context on c.UserContext() so downstream
//      DB queries and external HTTP calls that read c.UserContext() respect
//      the deadline and cancel themselves.
//   2. Runs the handler chain in a goroutine and waits with select so that if
//      the handler exceeds the deadline, we abandon it and return a 503
//      JSON error to the client immediately.
//
// All in-tree handlers were migrated to c.UserContext() so they propagate
// this deadline to DB queries and external HTTP calls. New handlers MUST use
// c.UserContext() (not c.Context(), which returns the longer-lived
// fasthttp.RequestCtx) for downstream context — otherwise this middleware
// will return 503 to the client but the runaway work will keep running in
// the background.
//
// Concurrency note: if the handler goroutine is still running when the
// timeout fires, we send the 503 from the request goroutine and let the
// handler goroutine finish on its own (its writes to c are dropped because
// the response has already been written). This avoids racing on the response
// writer at the cost of leaking goroutine work for the duration of the
// runaway handler.
func Timeout(d time.Duration) fiber.Handler {
	return TimeoutWithSkip(d, nil)
}

// TimeoutWithSkip is Timeout with a pre-handler escape hatch. If skip is
// non-nil and returns true for a request, the deadline isn't applied — used
// to exempt long-running LLM endpoints from the global 12s budget without
// nesting deadlines.
func TimeoutWithSkip(d time.Duration, skip func(c *fiber.Ctx) bool) fiber.Handler {
	if d <= 0 {
		d = DefaultRequestTimeout
	}
	return func(c *fiber.Ctx) error {
		if skip != nil && skip(c) {
			return c.Next()
		}
		parent := c.UserContext()
		ctx, cancel := context.WithTimeout(parent, d)
		defer cancel()
		c.SetUserContext(ctx)

		var handlerErr error
		var once sync.Once
		done := make(chan struct{})

		go func() {
			defer func() {
				if r := recover(); r != nil {
					once.Do(func() {
						handlerErr = errPanicked
					})
					log.Error().Interface("panic", r).Str("path", c.Path()).Msg("handler panic in timeout-wrapped route")
				}
				close(done)
			}()
			err := c.Next()
			once.Do(func() { handlerErr = err })
		}()

		select {
		case <-done:
			return handlerErr
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				log.Warn().
					Str("method", c.Method()).
					Str("path", c.Path()).
					Dur("budget", d).
					Msg("request timeout — handler exceeded deadline")
				return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
					"error":   "request timeout",
					"code":    "TIMEOUT",
					"timeout": d.String(),
				})
			}
			return ctx.Err()
		}
	}
}

var errPanicked = errors.New("handler panicked")
