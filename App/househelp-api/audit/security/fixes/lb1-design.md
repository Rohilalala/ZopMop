# LB-1: OTP dev-mode prod guard — design

## Audit finding

Launch blocker #1 from the 2026-05-21 security audit (PR #25).

`POST /auth/send-otp` returns plaintext OTP `"999999"` whenever
`OTP_DEV_MODE=true`, with no environment check. Today the production
default is safe because Railway has `OTP_DEV_MODE` unset (parsed as
`false`), but `.env.example` ships `OTP_DEV_MODE=true`. Anyone who
bulk-imports `.env.example` into Railway opens the bypass instantly
and silently — auditors can read the OTP straight out of the API
response.

## Two-layer fix

### Layer 1 — code: production guard

Gate the bypass on `!IsProduction()` so even if `OTP_DEV_MODE=true`
leaks into a production deploy, `APP_ENV=production` blocks the echo.

Implementation:

- `internal/auth/service.go`
  - `Service` gains `isProduction bool` field.
  - `NewService(... devOTPEnabled, isProduction bool) *Service`
    (one new constructor arg).
  - The bypass at `SendLoginOTP` changes from:
    ```go
    if s.otp.DevMode() {
        return devModeOTPVal, isNewUser, nil
    }
    ```
    to:
    ```go
    if s.otp.DevMode() && !s.isProduction {
        return devModeOTPVal, isNewUser, nil
    }
    ```
- `cmd/api/main.go:280` — pass `cfg.IsProduction()` as the new arg.

`isProduction` is captured at boot. Subsequent env mutations cannot
weaken the guard for the life of the process.

The `otpVendor.DevMode()` flag on the Message Central client stays
as-is. Its purpose is to short-circuit the network call when the
vendor credentials are absent (local dev). Behavioral compatibility
matters more than naming: even when `DevMode()` is true in
production, the bypass branch now skips the echo and falls through
to the standard `return "", isNewUser, nil`.

### Layer 2 — config hygiene

Flip `.env.example` from `OTP_DEV_MODE=true` to `OTP_DEV_MODE=false`
with a comment explaining the flip and the defense-in-depth posture.

## Truth table

| `OTP_DEV_MODE` | `IsProduction()` | Bypass returns 999999? | Notes |
|---|---|---|---|
| false | true  | no | normal prod path |
| false | false | no | normal dev path (vendor must be wired) |
| true  | true  | **no (NEW)** | guard blocks accidental prod misconfig |
| true  | false | yes | dev convenience preserved |

All four asserted in `service_devmode_guard_test.go`.

## Out of scope

- `handler.go:326` (`if otp != ""` response leak) — left intact. The
  handler is behaviorally correct; the bypass is the only thing that
  should ever populate the field, and Layer 1 closes that path.
- Message Central client `DevMode()` semantics — unchanged.
- No changes outside auth.
