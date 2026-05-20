# Phase 12 Backlog — deferred follow-ups

## OTP vendor swap (MSG91 → Message Central, 2026-05-20)

1. **Remove the legacy pure-Redis OTP path** — `Service.SendOTP`
   (`internal/auth/service.go`) + `Service.VerifyOTP` + their Redis OTP-gen.
   Unwired (no HTTP handler calls them) since the MSG91 cut-over.
2. **Remove `internal/auth/msg91_deprecated.go`** unless MSG91 is adopted for
   transactional (non-OTP) SMS.
3. **Return `OTP_EXPIRED` instead of `INVALID_OTP`** for an expired/missing
   `verificationId` in `VerifyLoginOTP`. Deferred to avoid changing the mobile
   contract during the vendor swap; `handler.go` already maps
   `ErrOTPExpiredOrNotFound` → 401 `OTP_EXPIRED`.
4. **vid eviction-resilience** — if Redis evicts `otp:vid:{phone}` before its
   TTL while `otp:cooldown:{phone}` is still set, the user is stuck: can't
   verify (no vid) and can't resend (cooldown). Unlikely under normal load,
   possible under Redis memory pressure / `maxmemory-policy allkeys-lru`.
   Investigate: pin vid keys, or clear the cooldown when the vid is missing.
