// Package observability wires Sentry for backend error tracking.
//
// Init is opt-in via SENTRY_DSN. If the env var is empty, every helper here
// is a no-op so dev / CI / local runs never need a Sentry project.
//
// To enable in prod, set the following on Railway:
//   SENTRY_DSN                    (required — from Sentry project settings)
//   SENTRY_ENVIRONMENT            (optional, defaults to APP_ENV or "production")
//   SENTRY_TRACES_SAMPLE_RATE     (optional, defaults to 0 — disabled performance monitoring)
//   SENTRY_RELEASE                (optional — pass the git SHA at build time
//                                  via Railway env or container label)
package observability

import (
	"os"
	"strconv"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/rs/zerolog/log"
)

// Init configures the global Sentry client. Safe to call when SENTRY_DSN is
// empty — returns nil and emits an Info log. Returns the flush function the
// caller should defer to ensure pending events ship before process exit.
func Init(appEnv string) func() {
	dsn := os.Getenv("SENTRY_DSN")
	if dsn == "" {
		log.Info().Msg("sentry: SENTRY_DSN not set; error tracking disabled")
		return func() {}
	}

	env := os.Getenv("SENTRY_ENVIRONMENT")
	if env == "" {
		env = appEnv
	}
	if env == "" {
		env = "production"
	}

	tracesRate := 0.0
	if raw := os.Getenv("SENTRY_TRACES_SAMPLE_RATE"); raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil {
			tracesRate = parsed
		}
	}

	release := os.Getenv("SENTRY_RELEASE")

	if err := sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Environment:      env,
		Release:          release,
		TracesSampleRate: tracesRate,
		// Attach stack traces to messages and exceptions automatically.
		AttachStacktrace: true,
		// Strip request bodies that may carry PII (phone, address, etc.).
		// We surface enough breadcrumbs from zerolog without paying that
		// data-residency tax.
		SendDefaultPII: false,
		// PII scrub before send.
		BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			scrubEvent(event)
			return event
		},
	}); err != nil {
		log.Error().Err(err).Msg("sentry: init failed")
		return func() {}
	}

	log.Info().
		Str("env", env).
		Float64("traces_rate", tracesRate).
		Msg("sentry: initialised")

	return func() {
		// Block up to 2s for pending events to flush. Anything longer means
		// Sentry is having a bad day and we'd rather not stall shutdown.
		sentry.Flush(2 * time.Second)
	}
}

// CaptureError sends a non-panic error to Sentry with the supplied tags.
// Safe to call when Sentry is uninitialised — sdk silently drops the event.
//
// Use this in error paths that should always surface (DB write failures,
// payment-webhook decode errors, Firebase token verification crashes, etc.).
// Routine 4xx user errors should not go through here.
func CaptureError(err error, tags map[string]string) {
	if err == nil {
		return
	}
	sentry.WithScope(func(scope *sentry.Scope) {
		for k, v := range tags {
			scope.SetTag(k, v)
		}
		sentry.CaptureException(err)
	})
}

// CaptureMessage sends a string message at the given level. Useful for
// "this shouldn't have happened" warning paths that aren't tied to a Go error.
func CaptureMessage(msg string, level sentry.Level, tags map[string]string) {
	sentry.WithScope(func(scope *sentry.Scope) {
		scope.SetLevel(level)
		for k, v := range tags {
			scope.SetTag(k, v)
		}
		sentry.CaptureMessage(msg)
	})
}

// scrubEvent removes obvious PII from an outgoing Sentry event so we don't
// rely on Sentry-side scrubbing alone. Extend as new sensitive fields appear.
func scrubEvent(event *sentry.Event) {
	if event == nil {
		return
	}
	if event.Request != nil {
		event.Request.Cookies = ""
		event.Request.Data = ""
		if h := event.Request.Headers; h != nil {
			for _, key := range []string{"Authorization", "Cookie", "X-Csrf-Token", "Idempotency-Key"} {
				delete(h, key)
			}
		}
	}
	// Drop user phone if anyone called scope.SetUser({Email: phone}).
	if event.User.Email != "" {
		event.User.Email = ""
	}
}
