// Package safe provides a typed event builder for log lines that should
// never carry PII. Each method takes a pre-classified field; there is no
// generic Str() / Interface() escape hatch. The friction is the point —
// adding a new field means adding a method, which forces a classification
// review before the log line lands.
//
// Use this package for new code. Existing log.Info() etc. call sites stay
// untouched and migrate opportunistically.
//
// Allowlist policy is documented in App/househelp-api/docs/logging.md.
//
// PII fields (phone, email, VPA, tokens) must be pre-redacted with the
// helpers in pkg/logger (MaskPhone, MaskEmail, MaskVPA, Stub) and passed
// in via the *Masked / TokenStub methods below.
package safe

import (
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// Event wraps a *zerolog.Event and exposes only allowlisted fields.
type Event struct {
	e *zerolog.Event
}

// ── Constructors ────────────────────────────────────────────────────────

func Info() *Event  { return &Event{e: log.Info()} }
func Warn() *Event  { return &Event{e: log.Warn()} }
func Error() *Event { return &Event{e: log.Error()} }
func Debug() *Event { return &Event{e: log.Debug()} }

// ── Identity (pseudonymous UUIDs — always safe) ─────────────────────────

func (e *Event) UserID(id string) *Event    { e.e = e.e.Str("user_id", id); return e }
func (e *Event) HelperID(id string) *Event  { e.e = e.e.Str("helper_id", id); return e }
func (e *Event) BookingID(id string) *Event { e.e = e.e.Str("booking_id", id); return e }
func (e *Event) RefundID(id string) *Event  { e.e = e.e.Str("refund_id", id); return e }
func (e *Event) PaymentID(id string) *Event { e.e = e.e.Str("payment_id", id); return e }
func (e *Event) AdminID(id string) *Event   { e.e = e.e.Str("admin_id", id); return e }
func (e *Event) RequestID(id string) *Event { e.e = e.e.Str("request_id", id); return e }
func (e *Event) TargetID(id string) *Event  { e.e = e.e.Str("target_id", id); return e }
func (e *Event) WebhookID(id string) *Event { e.e = e.e.Str("webhook_id", id); return e }

// ── Operational (always safe) ───────────────────────────────────────────

func (e *Event) Action(a string) *Event { e.e = e.e.Str("action", a); return e }
func (e *Event) Event(name string) *Event {
	e.e = e.e.Str("event", name)
	return e
}
func (e *Event) Status(s string) *Event { e.e = e.e.Str("status", s); return e }
func (e *Event) Phase(p string) *Event  { e.e = e.e.Str("phase", p); return e }
func (e *Event) Module(m string) *Event { e.e = e.e.Str("module", m); return e }
func (e *Event) Method(m string) *Event { e.e = e.e.Str("method", m); return e }
func (e *Event) Path(p string) *Event   { e.e = e.e.Str("path", p); return e }
func (e *Event) Code(c string) *Event   { e.e = e.e.Str("code", c); return e }

// ── Numeric (always safe) ───────────────────────────────────────────────

func (e *Event) Count(n int) *Event       { e.e = e.e.Int("count", n); return e }
func (e *Event) Attempt(n int) *Event     { e.e = e.e.Int("attempt", n); return e }
func (e *Event) DurationMs(ms int64) *Event {
	e.e = e.e.Int64("duration_ms", ms)
	return e
}

// ── Financial (always safe in operational logs per audit policy) ────────

func (e *Event) AmountPaise(p int64) *Event { e.e = e.e.Int64("amount_paise", p); return e }

// ── Pre-redacted PII (caller MUST use logger.Mask* / Stub helper) ──────

func (e *Event) PhoneMasked(masked string) *Event { e.e = e.e.Str("phone_mask", masked); return e }
func (e *Event) EmailMasked(masked string) *Event { e.e = e.e.Str("email_mask", masked); return e }
func (e *Event) VPAMasked(masked string) *Event   { e.e = e.e.Str("vpa_mask", masked); return e }
func (e *Event) TokenStub(stub string) *Event     { e.e = e.e.Str("token_stub", stub); return e }

// ── Errors ─────────────────────────────────────────────────────────────
//
// Note: zerolog passes err.Error() through verbatim. Whether an error
// string carries PII is the error-construction site's responsibility
// (see B2-05 redaction work). Err() here adds no PII layer of its own.

func (e *Event) Err(err error) *Event { e.e = e.e.Err(err); return e }

// ── Terminal ───────────────────────────────────────────────────────────

func (e *Event) Msg(msg string) { e.e.Msg(msg) }
