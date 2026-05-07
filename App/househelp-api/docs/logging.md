# Safe logging

The Go service uses [zerolog](https://github.com/rs/zerolog) for structured
output. Two logging APIs coexist; new code should prefer the second.

## Quick rules

- **UUIDs and IDs:** log freely. `user_id`, `booking_id`, `helper_id`,
  `refund_id`, `request_id`, etc. are pseudonymous and safe.
- **Operational fields:** log freely. `status`, `action`, `event`,
  `phase`, `module`, `path`, `method`, `code`, `count`, `duration_ms`,
  `attempt`.
- **Financial amounts:** log freely. Use `AmountPaise(...)` on the safelog
  builder or `Int64("amount_paise", ...)` on the raw zerolog event.
- **PII (phone, email, VPA, address):** redact via the helpers in
  `pkg/logger`. Never log raw values.
- **Tokens / session IDs / idempotency keys:** redact via `logger.Stub`
  (default 8-char prefix + `...`).
- **Free-text content (chat, message bodies, names, addresses):** do not
  log raw text. Log lengths, IDs, counts, or skip entirely.

## Helpers (`pkg/logger`)

| Helper | Purpose | Example |
|---|---|---|
| `MaskPhone(phone)` | Trailing-4 digits visible | `+919876543210` → `***3210` |
| `MaskEmail(email)` | First char + domain | `john@example.com` → `j***@example.com` |
| `MaskVPA(vpa)` | Domain visible | `aditya@okhdfcbank` → `***@okhdfcbank` |
| `Stub(s, n)` | First N chars + `...` | `Stub("eyJhbGciOiJIUzI1NiJ9...", 8)` → `eyJhbGci...` |

All four return `"***"` (or `"..."` for Stub) when given empty / invalid
input — never the original value.

## Two APIs

### Existing code: zerolog directly

```go
import "github.com/rs/zerolog/log"

log.Info().
    Str("user_id", id).
    Str("phone_mask", logger.MaskPhone(phone)).
    Msg("[auth] otp sent")
```

This is the dominant pattern across the ~570 existing log sites. They
stay as-is; the `Str("phone_mask", ...)` convention plus the helpers
above is enough when reviewers are paying attention.

### New code: `pkg/logger/safe`

```go
import safelog "github.com/adityarohilla/househelp-api/pkg/logger/safe"

safelog.Info().
    UserID(id).
    PhoneMasked(logger.MaskPhone(phone)).
    Action("otp_sent").
    Msg("[auth] otp sent")
```

The `safe` package exposes a typed event builder with **no `.Str()` /
`.Interface()` escape hatch**. Every method takes a pre-classified field;
adding a new field means adding a method, which forces classification
review at the API edit site.

This is the structural fix the audit's F1-D cluster called for. Use it
for new log lines.

## Migration

Old log lines stay as they are. When you touch a file for other reasons,
opportunistically migrate its log lines to the safe package. Don't open
churn-PRs that only do log-line rewrites.

## Adding a new field

Edit `pkg/logger/safe/safe.go`. Add a method named after the classification:

- IDs → group with the existing `UserID`, `HelperID`, ... block
- Operational → group with `Action`, `Status`, ...
- Numeric → group with `Count`, `DurationMs`, ...
- PII → reject. Add a `Mask*` helper in `pkg/logger` first; expose only
  the masked form here.

The method's name and group locate the classification decision in code
review.

## Anti-patterns

Don't:
- `log.Info().Interface("data", anyMap).Msg(...)` — always dumps too much.
- `log.Info().Str("body", body).Msg(...)` — log a length or ID instead.
- `log.Info().Str("query", c.Request().URI().String()).Msg(...)` — query
  strings carry session tokens, OTPs, and emails.
- `log.Error().Err(rawDBErr).Msg(...)` — DB errors can include row data.
  Wrap with a domain error first; see audit B2-05 for the pattern.

If a redaction helper doesn't exist for what you want to mask, add it
to `pkg/logger` first, then use it.
