# Security Audit — Independent Review

Reviewer pass over `SYNTHESIS.md` top 10 + open questions. Branch `feature/security-audit-2026-05-21`. All file paths are repo-relative.

---

## 1. Confirmed

These findings match the code as cited; severity/scope unchanged.

- **B-001 / S-002 (CRITICAL, OTP dev-mode bypass).** Confirmed.
  - `App/househelp-api/pkg/config/config.go:146` reads `OTP_DEV_MODE` and `validate()` (lines 190–283) has no `if OTPDevMode && !IsDevelopment()` refusal.
  - `App/househelp-api/internal/auth/service.go:424-426` returns `devModeOTPVal` (= `"999999"`, defined `internal/auth/messagecentral.go:43`) whenever the OTP vendor is in dev mode.
  - `App/househelp-api/internal/auth/handler.go:326-329` writes both `otp` and a `note` field into the public response.
  - **Caveat that slightly softens severity:** `Env` defaults to `"production"` when `APP_ENV` is unset (`config.go:101`), so a missing env var fails safe on the production check at `config.go:245`. The hole is when an operator explicitly sets `APP_ENV=staging` (or anything other than `production`) **and** leaves `OTP_DEV_MODE=true`. Still CRITICAL.

- **D-001 / B-006 (CRITICAL, OTP SMS DoS + enumeration).** Confirmed.
  - Limits at `App/househelp-api/internal/auth/ratelimit.go:33-41` (3/15m phone, 5/15m IP). No global cap.
  - `is_new_user` is returned in the unauthenticated `SendOTP` response at `internal/auth/handler.go:324`. Pre-verify enumeration is trivial.

- **S-001 (CRITICAL, Maps key in history).** Confirmed via `git log --all -p -S "AIzaSy"`. Both `AIzaSyDvyOQs4SFHLZoupsERIXBCKUhAHMSJU7w` and `AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0` are reachable in commits `659a79f`, `b815c0a`, `7a0b4df`, `89f568f` etc. Out of HEAD tree but permanently in history.

- **C-004 (HIGH, webhook SSRF DNS-rebinding).** Confirmed verbatim.
  - `internal/webhooks/ssrf.go:52-55` is an explicit comment: *"this does NOT defend against DNS rebinding ... we rely on a network policy at the cluster level"*.
  - `validateWebhookTarget` only resolves once via `net.LookupIP` (line 84). The actual `http.Do` happens later with the URL — no `DialContext` re-validation.

- **S-003 / E-001 (HIGH, Sentry PII bleed).** Confirmed.
  - `internal/observability/sentry.go:115-132` `scrubEvent` only clears `Request.Cookies`, `Request.Data`, a hardcoded list of headers, and `User.Email`. It never walks `event.Extra`, `event.Tags`, `event.Breadcrumbs`, or `event.Request.URL` (query string). Any handler that does `scope.SetTag("phone", ...)` or appends a breadcrumb with a token leaks.

- **B-002 (HIGH, suspension DB lookup per request).** Confirmed.
  - `internal/middleware/auth.go:139-149`: `checker.IsSuspended` is a synchronous PK query on every authed request and **fail-closed** with 503. No Redis cache. A DB blip 503s the entire API.

- **B-003 (HIGH, no `iss`/`aud`).** Confirmed.
  - `internal/middleware/jwt.go:17-72`: validates only HMAC method + signature against the key set. No claim assertion on `iss`, `aud`, `typ`/`user_type` (typ is read later but not validated in the JWT layer), no `exp` enforcement explicit here (relies on jwt-go default).

- **B-007 / D-002 (HIGH, OTP limiter fail-open).** Confirmed.
  - `internal/auth/ratelimit.go:110-112` — on `Incr` error: *"Fail open — see file header for rationale."* The header rationale (lines 26-30) calls this acceptable because the outer `SensitivePublicRateLimit` (20/min) "fails closed". But that outer limiter is per-IP and does nothing against a botnet, so this absolutely compounds D-001.

- **Cashfree webhook signature path** has no auth middleware (REPO_MAP §10). `cmd/api/main.go:598` is the registration site. The handler signature check + dedupe (see Open Q #3 below) is the only gate. Confirmed safe-but-fragile.

---

## 2. Refuted (false positives or substantially overstated)

- **D-005 / B-012 (claim: "WS booking-track on public bucket no auth → location stream leak + conn-exhaustion").** **Largely REFUTED.**
  - `internal/booking/tracking_ws.go:97-115` requires an `auth` message containing a valid JWT before any tracking data is written. Auth handshake is bounded by `trackingWSAuthDeadline` (line 92, `SetReadDeadline`).
  - Live suspension check at lines 118-138.
  - Booking ownership/authorization is enforced inside `service.GetTracking(ctx, bookingID, userID)` at line 195 — every push call re-checks.
  - Read deadlines + ping/pong + done channel are wired (lines 149-152, 166-189).
  - The legitimate concerns that remain are (a) no per-user concurrent-WS cap and (b) the WS lives in the `publicLimiter` bucket. Downgrade to **MEDIUM**; recommend an explicit per-user connection cap, but JWT-validation timing is fine.

- **S-004 (Firebase parse-error logs raw value).** **REFUTED** for `internal/credentials/firebase.go`. The file (28 lines total) contains zero log statements; the parse decision is a `strings.HasPrefix(..., "{")` check (line 24) and the raw value never reaches a logger here. If S-004 still has teeth it must be elsewhere — re-scope to the callers (`internal/notification/service.go:42` etc.).

---

## 3. Amended (partially right)

- **B-005 (HIGH, CRM admin role downgrade not enforced until session expiry).** **AMENDED, still HIGH.**
  - The CRM JWT middleware at `internal/crm/middleware/jwt.go:83-102` **does** hit the DB per request — but only to check `revoked_at IS NULL AND expires_at > now()` on `crm_admin_sessions`. It does **not** re-read `role` (line 70 stores the JWT-claim role into `crmAdminID`/`crmAdminRole`).
  - Implication: a sysadmin who downgrades an admin from `super_admin` to `viewer` must also revoke the active session to take effect immediately, or the demoted admin retains full power until token TTL.
  - Fix is smaller than the synthesis suggests: extend the same SQL query to return `role`, override the locals. ~10 LOC. Severity remains HIGH for a CRM with 5+ admins; could be downgraded for the 5-pro pilot only if you commit to revoking sessions on every role change.

- **B-010 (no CRM CSRF — flagged in REPO_MAP "Surprises").** **AMENDED — REAL but BOUNDED.**
  - `App/zopmop-crm/src/api/client.ts:17` uses `withCredentials: true` and the refresh cookie is HttpOnly per the comment.
  - `internal/middleware/csrf.go` is registered on the customer/pro app (`cmd/api/main.go:235`) but **not** on the CRM app (REPO_MAP §5 confirms).
  - Access-token endpoints use Bearer (`client.ts:33`) and CSRF-skip on Bearer (`csrf.go:42-44`). The cross-site exposure surface is only the cookie-authenticated `/admin/auth/refresh` endpoint (`client.ts:54-58`). A CSRF on `/admin/auth/refresh` would mint a new access token, but CORS prevents the attacker page from reading the response body — so practical exploitation is limited to forcing token rotation (mild DoS / session-pinning vector), not direct ATO. Treat as **MEDIUM**, not HIGH. Add CSRF to `/admin/auth/refresh` only, or an `Origin` header allowlist check.

- **B-015 / QW-4 (CRM 403 leaks `required_role`/`your_role`).** **CONFIRMED but note:** the CRM SPA actively consumes those fields to render a precise toast (`App/zopmop-crm/src/api/client.ts:115-122`). Removing them server-side will break the toast unless the SPA is updated in lockstep. Recommend stripping the fields and updating the SPA toast to "Insufficient permissions" — small two-commit change.

- **QW-6 (require `JWT_ACCESS_SECRET != JWT_REFRESH_SECRET` and length ≥ 32).** **PARTIALLY REDUNDANT.** `pkg/config/config.go:356-384` already enforces length ≥ 64 and rejects blocklisted defaults. What's missing is the **equality** check between access and refresh secrets (and between either and the legacy `JWT_SECRET`). Recommend just that single equality check; length floor is already stronger than the quick-win text.

---

## 4. Open questions answered

- **Q3 (Cashfree webhook idempotency in `dispatchCashfreeEventTx`).** **Yes — dedupes.**
  - `internal/payments/handler.go:854` wraps the dispatch in `ConsumeOnceTx(processCtx, h.db, eventID, …)`.
  - `eventID` resolution at lines 842-848: prefers `env.EventID`, falls back to `cfPaymentID`, then `type:order_id`. Some fallback paths can collide (e.g. two distinct events with same `type` + `order_id` and no `event_id` would dedupe to one), but Cashfree's standard payloads populate `EventID`. **Downgrade C-006/D-004 to LOW** in normal operation; flag the fallback-collision edge as a follow-up.

- **Q4 (WS JWT validation timing).** Answered in §2 above — validation happens **after** upgrade but **before** any data is sent, bounded by a read deadline (`internal/booking/tracking_ws.go:92`). Acceptable.

- **Q5 (CRM token transport).** Bearer-in-header for access; HttpOnly cookie for refresh. See §3 B-010 amendment.

- **Q9 (Firebase parse-error log).** No raw value logged in `internal/credentials/firebase.go`. Recheck callers if S-004 stays in scope.

- **Q19 (CSRF cookie storage).** `internal/middleware/csrf.go:33-37`: `CookieName: "csrf_"`, `HTTPOnly: false` (required for double-submit), `Secure: isProduction`, `SameSite: "Strict"`, `Expiration: 1h`. Correct.

- **Q17 (JWT secret length validation).** `pkg/config/config.go:361` already enforces `len(secret) < 64 → error`, with blocked-substring list (lines 340-347). Stronger than the synthesis assumed. QW-6 is mostly already done — only the access-vs-refresh equality check is genuinely missing.

---

## 5. Newly discovered findings (not in synthesis or original five)

- **N-001 (HIGH) — CRM `/admin/auth/refresh` cross-site reachable, no CSRF, no Origin check.** `App/zopmop-crm/src/api/client.ts:54-58` POSTs to `/admin/auth/refresh` with `withCredentials: true`. The CRM Fiber app has no CSRF middleware (REPO_MAP §5, lines 140-147). A malicious page on a phished admin's browser can force token rotation; combined with any future XSS in the CRM SPA this becomes a stronger ATO chain. Fix: explicit CSRF on the refresh endpoint, or add `Origin` header allowlist in `corsMiddleware`. (Subset of B-010 but worth tracking on its own.)

- **N-002 (MEDIUM) — CRM JWT middleware never re-reads `role` from DB.** `internal/crm/middleware/jwt.go:69-71` trusts the JWT claim for role. The session-active check at lines 91-97 already runs a DB query — adding `role` to that `SELECT` closes the gap with no extra round-trip. Filed under B-005 amendment, but the implementation insight (one-line SQL change, not Redis caching) is new.

- **N-003 (MEDIUM) — Cashfree webhook `eventID` fallback can collide.** `internal/payments/handler.go:842-848` falls back to `type:order_id` when both `event_id` and `cfPaymentID` are missing. Two distinct events of the same type for the same order (unlikely from Cashfree, but possible in replay/edge cases) would dedupe to a single side-effect. Recommend rejecting webhooks with missing `event_id` *and* missing `cf_payment_id` rather than synthesising a key.

- **N-004 (LOW) — `internal/middleware/admin.go:27` literal `"userID"` instead of `LocalsKeyUserID` constant.** Already QW-5; confirming the line number. Same file uses `c.Locals("adminID", ...)` and `c.Locals("permissions", ...)` as bare strings (lines 51-52, 99-100) — recommend introducing constants for these too while you're in there.

- **N-005 (LOW) — Tracking-WS sends `service temporarily unavailable` on suspension-check DB error.** `internal/booking/tracking_ws.go:130` returns a JSON message then closes — but the message is unauthenticated-receivable since auth already passed. Fine; only flagging that ws-side error texts are sometimes more verbose than the REST-side equivalents. Low risk.

- **N-006 (LOW) — `OTP_DEV_MODE` true would still pass `cfg.validate()` when `APP_ENV=staging`.** `pkg/config/config.go:245` gates only on `IsDevelopment()` (=== `"development"`); `IsProduction()` returns true only when `Env == "production"`. Anything else (e.g. `staging`, `prod`, empty-with-default `production`) is a grey zone. Recommend a stricter `IsNonDevelopment()` check anywhere security-relevant flags are gated, or normalise `Env` to `{development, staging, production}` at parse time.

- **N-007 (LOW) — `CSRF` middleware skips on any `Authorization: ...` header presence (`csrf.go:42`).** A request that *intends* to be cookie-authed but also sends a stray (even invalid) Authorization header bypasses CSRF entirely. Browsers don't auto-set Authorization, so practical exploitation requires the attacker to be able to inject headers (which already implies XSS or worse), but the bypass logic should at least require a structurally valid Bearer token.

---

## 6. Final recommendation

**Keep the launch-blocker list as it stands, with two adjustments.**

1. **D-005/B-012 (rank 10) should drop off** the top 10 — WS JWT timing is fine. Replace it with **N-001 (CRM refresh CSRF)** in that slot; it's a real cross-site issue that the synthesis missed because Phase 1 didn't run the CRM-frontend / backend-CSRF cross-pass.

2. **B-005 (rank 8) can ship with a one-line SQL change** (add `role` to the session-active SELECT and overwrite locals) rather than the Redis-cached DB call the synthesis recommends. Take the 10-minute fix.

The three CRITICALs (B-001/S-002, D-001/B-006, S-001) remain genuine launch blockers. The C-004 SSRF DialContext fix is non-negotiable before any CRM admin can configure a webhook target. Everything else is shippable for a 5-customer/5-pro pilot if the four blockers close and PR-1+2+3 land per the synthesis sequencing.

End of review.
