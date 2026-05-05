package middleware

import (
	"context"
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// DefaultRequestTimeout is the per-request deadline applied to every route.
// 12s leaves headroom for slow database queries while still bounding the
// worst-case response time the client sees.
const DefaultRequestTimeout = 12 * time.Second

// Timeout returns a Fiber middleware that bounds the request's execution
// time via context cancellation. It does NOT spawn a goroutine — the
// handler runs in the request's own goroutine and is expected to observe
// ctx.Done() through DB queries / HTTP calls / explicit selects, returning
// when the deadline fires.
//
// Audit C-4 / B1-2 fix: the previous implementation forked the handler
// into a goroutine and sent the 503 from the parent. fasthttp pools the
// underlying RequestCtx between connections, so a still-running handler
// goroutine writing to that ctx after the parent returned could land on
// a different user's response — a cross-user data leak. This rewrite
// eliminates the goroutine and the race entirely.
//
// Late-completion handling: if the handler ignores ctx and runs past the
// deadline, we observe ctx.Err() == context.DeadlineExceeded after c.Next()
// returns. If the handler still wrote a response, we DO NOT overwrite it —
// just log a warn so ops can spot ctx-ignorant code. If the handler
// returned without writing (typical: it propagated ctx.Err()), we send the
// 503 JSON.
//
// Backstop: a handler that completely ignores ctx and never returns is
// bounded at the connection layer by Fiber's WriteTimeout in fiber.Config.
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

		// Snapshot the response state pre-handler so we can tell whether a
		// late-completing handler actually wrote anything. fasthttp defaults
		// StatusCode to 200 even before any write, so "status != 200" alone
		// is a poor signal — diff against the snapshot instead.
		beforeStatus := c.Response().StatusCode()
		beforeBodyLen := len(c.Response().Body())

		start := time.Now()
		err := c.Next()

		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			afterStatus := c.Response().StatusCode()
			afterBodyLen := len(c.Response().Body())
			wroteResponse := afterStatus != beforeStatus || afterBodyLen != beforeBodyLen

			if wroteResponse {
				// Handler ran past the deadline AND wrote a response. Don't
				// overwrite — that would be the very ctx-after-release race
				// this rewrite exists to prevent. Log so ops can flag the
				// ctx-ignorant call site.
				log.Warn().
					Str("method", c.Method()).
					Str("path", c.Path()).
					Dur("budget", d).
					Dur("over_by", time.Since(start)-d).
					Msg("[timeout] handler completed past deadline (ignored ctx); response preserved")
				return err
			}

			// Handler returned without writing — typically it observed
			// ctx.Done() and propagated ctx.Err(). Safe to send the 503 from
			// here because no concurrent writer exists.
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

		return err
	}
}
