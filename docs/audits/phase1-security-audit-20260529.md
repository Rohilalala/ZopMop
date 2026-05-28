# Phase 1 Security Audit

**Date:** 2026-05-29
**Auditor:** Security review (read-only)
**Branches in scope:**
- `feature/otp-namespace-separation` (backend Steps 0–3, chargeability guard, cross-app SendData pushes, dev seed harness)
- `feature/pro-app-two-otp-flow` (pro + customer app: OTP entry, payment-status display, end-of-service payment, home pill, TrackLive extensions, Cart cleanup)

This document is **advisory only**. No code was modified. No fixes were applied.

---

## Scope and method

Commits enumerated via `git log develop..feature/otp-namespace-separation` (21 commits) and
`git log develop..feature/pro-app-two-otp-flow` (28 commits, sharing the backend base). The two
branches share the backend commits `1303d59`…`3c94546`; `feature/otp-namespace-separation` carries
8 backend-only commits beyond that (`cf538bb`, `e1e703e`, `2c8016a`, `d2ff0d1`, `24ba111`,
`69667a2`, `4afbe69`, `5680bdd`).

Every changed file was read directly from the git object store and working tree. Citations use
`file:line`. Backend Go was the focus (the security-bearing surface); the React Native client was
reviewed for OTP/secret leakage and server-trust assumptions. The cross-app push code
(`cf538bb`/`e1e703e`) lives only on `feature/otp-namespace-separation` and was read from that
branch's blobs.

Areas covered: authentication/authorization on every booking/payment/OTP/cash endpoint; OTP
brute-force, rate-limit, namespace separation, desync and leakage; the dev seed harness gating; the
`DecideChargeable` chargeability guard; cross-app FCM pushes; the Cashfree webhook
(signature/replay/SSRF); rate-limit key shapes; input validation; logging; and the
race windows between webhook, cash-resolve, OTP self-heal and completion.

> **Tooling note.** The file-read tool returned stale content for one file during this audit; all
> cited line numbers were re-confirmed with `grep -n` / `sed -n` / `git show` against the actual
> blobs. Where a finding sits on `feature/otp-namespace-separation` only, that is stated inline.

---

## Findings summary (counts by severity)

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 1 |
| Medium   | 2 |
| Low      | 6 |
| Info     | 5 |

The two-OTP payment gate is well-built: cryptographically-random codes, constant-time compare,
one-time consume, mismatch does not evict the stored code, INCR-before-check rate limiting that
closes the "is a code outstanding?" side channel, structurally-disjoint login vs service OTP
namespaces (unit-proven), and a customer-only gate on OTP-code surfacing. No authentication bypass,
no unauthenticated state mutation, no OTP leak to the pro side, and no admin-endpoint bypass were
found. The single High is a financial-integrity double-charge race, not an access-control hole.

---

## High findings

### S-001 — Cash + online double-charge window (ResolveCash 2-minute freshness vs. webhook with no cash guard)
- **Severity:** High
- **Location:** `internal/booking/service.go:431-447` (ResolveCash residual-race guard); `internal/payments/handler.go:1013-1018` (webhook PAYMENT_SUCCESS stamp)
- **Description:** `ResolveCash` refuses cash only while a `cashfree` payment row is `pending` **and** was
  `created_at > NOW() - INTERVAL '2 minutes'` (`service.go:439`). Once that pending order is older than
  two minutes it is treated as "abandoned" and cash is permitted. But the pending Cashfree order is
  never cancelled/voided — if the UPI collect succeeds later (slow mandate, >2 min), the
  `PAYMENT_SUCCESS_WEBHOOK` handler blindly runs
  `UPDATE bookings SET payment_status = 'paid' ... WHERE id = $1 AND payment_method = 'cashfree'`
  (`handler.go:1013-1018`) **with no check on `cash_collected_at`**. The booking then carries both
  `cash_collected_at` (pro owes cash) and `payment_status='paid'` (gateway settled) — the customer has
  paid twice. `DecideChargeable` only blocks opening a *new* order; it does not stop settlement of an
  already in-flight one.
- **Why it matters:** Automatic double-charge with no attacker required and no automatic
  reconciliation — the customer is debited online and has handed cash to the pro. Recovery is a manual
  CRM refund. The window is narrow (UPI success arriving >2 min after the customer gave up and paid
  cash) but it is a real money-loss path on the core payment flow about to go to pilot.
- **Suggested fix:** Make the cash/online settlement mutually exclusive at the database write, not just
  at order-open time. When `ResolveCash` stamps `cash_collected_at`, also mark the outstanding
  Cashfree order so the webhook can detect it; and have the `PAYMENT_SUCCESS_WEBHOOK` branch refuse to
  set `payment_status='paid'` (instead routing to an auto-refund / reconciliation path) when
  `cash_collected_at IS NOT NULL` for that booking. Take the booking row `FOR UPDATE` in the webhook
  path so the cash stamp and the paid stamp serialize on the same lock. A DB `CHECK` that the two
  resolution columns are not both set (see S-006) would turn any residual race into a loud failure
  rather than a silent double-charge.

---

## Medium findings

### S-002 — OTP `Verify` runs before the assigned-helper ownership check; per-booking rate-limit lets any approved pro lock/burn another booking's gate
- **Severity:** Medium
- **Location:** `internal/booking/service.go:1970` (StartBooking: `Verify(ScopeStart, bookingID, …)` before the `WHERE … helper_id = $2` UPDATE at `:1979-1984`); `internal/booking/service.go:2200` (CompleteBooking: same pattern before `:2229-2236`); rate-limit key shape `internal/otp/otp.go:252-254`
- **Description:** Both gate handlers verify the submitted OTP **before** confirming the caller is the
  assigned helper — the helper-assignment check lives only in the subsequent `UPDATE … WHERE … helper_id = $2`.
  `Verify` is keyed solely on `(scope, bookingID)`. The route is gated by `RequireRole("pro")` +
  approval (`handler.go:45-50`), so any *approved pro* may submit OTP attempts against *any* booking ID.
  Because the rate-limit counter key is per-booking (`otp:verify-attempts:{scope}:{bookingID}`,
  `otp.go:252`) and is **not** reset by `Issue`, 11 wrong submissions lock that booking's gate for the
  full 5-minute window for everyone — including the legitimately-assigned pro. Approved pros routinely
  learn real booking UUIDs from `GET /bookings/helper/invites` (`service.go:1744`) even for jobs they
  never accept.
- **Why it matters:** A malicious or buggy approved pro can (a) **deny** the start/complete gate on
  bookings they were merely invited to by burning the attempt budget, and (b) on a lucky correct guess,
  *consume* the legitimate outstanding code (one-time `Del`), forcing the real pro to wait for the
  TrackLive self-heal to re-issue. Brute-force success is ~7e-5 over a 6-hour TTL, so (a) the DoS is the
  practical risk; (b) is low-probability. No customer data is exposed.
- **Suggested fix:** Check booking ownership/state **before** calling `Verify`: load the booking row and
  confirm `helper_id = caller AND status = 'accepted'` (start) / `'in_progress'` (complete) first, and
  only then verify the OTP. That way an unassigned pro can neither burn the counter nor consume the
  code. Optionally scope the attempts counter per `(booking, helper)` so one pro cannot exhaust
  another's budget even if the ordering is kept.

### S-003 — End-OTP self-heal can re-mint a just-consumed End OTP (consume→commit race)
- **Severity:** Medium
- **Location:** `internal/booking/self_heal.go:101-112` (`DecideEndOTPSelfHeal`); `internal/booking/service.go:2200` (Verify deletes code) vs `:2310` (status commit); `internal/booking/service.go:1901-1925` (GetTracking End self-heal, stale `booking.Status`, SELECT omits `end_otp_verified_at`)
- **Description:** `CompleteBooking` calls `Verify(ScopeEnd,…)` at `service.go:2200`, which deletes the
  code from Redis on success, and only *then* opens a transaction and stamps `status='completed'` +
  `end_otp_verified_at = NOW()` (committed at `:2310`). During the sub-second window between the Redis
  delete and the commit, a concurrent `GetTracking` push tick (WS pushes every ~5s per in-flight
  booking) sees: `Peek → ""` (code gone), the **stale** in-memory `booking.Status == in_progress`
  (snapshot taken at `:1806`), and `payment_status='paid'` (fresh SELECT at `:1905`).
  `DecideEndOTPSelfHeal` returns `SelfHealIssue` because it never inspects `end_otp_verified_at` — the
  very column migration 112 added to record this transition — and GetTracking's self-heal SELECT
  (`:1905`) pulls only `payment_status, cash_collected_at`. A fresh, valid End OTP is therefore minted
  for a booking that is being / has just been completed.
- **Why it matters:** Violates the one-shot invariant of the completion gate and can leave a live End OTP
  in Redis (TTL up to 6h) against a completed booking. Direct re-completion is blocked by the
  `WHERE … status = 'in_progress'` guard on the complete UPDATE, so the impact is desync / customer
  confusion (TrackLive re-showing a code) rather than a second completion — unless the original commit
  rolls back, in which case the booking is recoverable anyway. Bounded, but it defeats the stated
  "never regenerate after the gate is consumed" design.
- **Suggested fix:** Add an `endOTPVerified` precondition to `DecideEndOTPSelfHeal` and return
  `SelfHealSkip` when `end_otp_verified_at IS NOT NULL`; include that column in the GetTracking self-heal
  SELECT at `service.go:1905`. Because `end_otp_verified_at` is stamped in the same atomic UPDATE that
  flips status, once visible the heal can never re-fire. (The Start path has the analogous, lower-impact
  window — see S-007.)

---

## Low findings

### S-004 — Dev seed harness compares `X-Dev-Seed-Key` with non-constant-time `!=`
- **Severity:** Low
- **Location:** `internal/booking/dev_seed.go:118` — `if supplied == "" || supplied != configured {`
- **Description:** The dev-seed shared secret is matched with Go's short-circuiting string `!=` rather
  than `crypto/subtle.ConstantTimeCompare`, despite the file gating a high-privilege capability
  (force booking state, mint OTPs, upsert an approved pro).
- **Why it matters:** Network timing side-channels are largely theoretical and this endpoint is excluded
  from the prod binary by the build tag (see "checked clean"), so exposure is dev-only. Still cheap
  insurance for a secret-gated, state-mutating route.
- **Suggested fix:** Use `subtle.ConstantTimeCompare([]byte(supplied), []byte(configured)) == 1` after the
  empty-string guard.

### S-005 — Migration 112 adds no integrity constraints coupling the payment-gate columns
- **Severity:** Low
- **Location:** `migrations/112_otp_payment_gates.up.sql` (the `ALTER TABLE bookings ADD COLUMN … cash_collected_by_pro / cash_collected_at / start_otp_verified_at / end_otp_verified_at`)
- **Description:** All four new columns are nullable with no `CHECK`. Nothing enforces that
  `cash_collected_by_pro` and `cash_collected_at` are set together, nor that `cash_collected_at` and
  `payment_status='paid'` are mutually exclusive. The completion gate treats either resolution as
  sufficient (`service.go:2234`), so a row with a half-written cash pair, or with both online-paid and
  cash-collected set (cf. S-001), is silently accepted.
- **Why it matters:** Integrity hardening. The nullable design is *fail-safe on the gate itself* (NULL =
  "not resolved"), so this is not an active bypass, but a partial write would corrupt the CRM
  owes-per-pro attribution (keyed on `cash_collected_by_pro`) while still passing completion.
- **Suggested fix:** Add a forward-only constraint
  `CHECK ((cash_collected_by_pro IS NULL) = (cash_collected_at IS NULL))`, and — if the business rule is
  one-path-only resolution — a constraint forbidding both `cash_collected_at` and `payment_status='paid'`.
  Use `NOT VALID` then `VALIDATE CONSTRAINT` to avoid a blocking lock on existing rows.

### S-006 — Login-OTP Redis key rename drops in-flight codes and lockouts across the deploy window
- **Severity:** Low
- **Location:** `internal/auth/service.go` (commit `1303d59`: `otp:{phone}` → `otp:login:code:{phone}`, `otp:vid:` → `otp:login:vid:`, `otp:fail:` → `otp:login:fail:`, `otp:lock:` → `otp:login:lock:`)
- **Description:** At the moment `1303d59` deploys, any state stored under the old un-namespaced keys
  becomes unreadable by the new code. A user mid-verify gets a spurious failure; more notably, an active
  brute-force **lockout** under `otp:fail:{phone}` / `otp:lock:{phone}` is silently abandoned, resetting
  that phone's failed-attempt counter to zero for the remainder of its TTL.
- **Why it matters:** A one-time, deploy-window-only relaxation of the login lockout. Self-heals within
  `otpExpiry`; the new namespace enforces the cap immediately for fresh attempts.
- **Suggested fix:** Deploy off-peak and run a one-shot Redis cleanup of the stale un-namespaced
  `otp:vid:* / otp:fail:* / otp:lock:* / otp:cooldown:*` shapes so no orphaned keys linger; no code change
  required.

### S-007 — Start-OTP self-heal shares the same consume→commit re-mint window (inert post-start)
- **Severity:** Low
- **Location:** `internal/booking/self_heal.go:70-84` (`DecideStartOTPSelfHeal`); `internal/booking/service.go:1970` (Verify) vs the StartBooking UPDATE
- **Description:** Same root cause as S-003 on the Start path. The `booking.StartedAt != nil` "defensive
  belt" only protects loads after the commit is visible; between the Start-OTP `Verify` (Redis delete)
  and the StartBooking commit, the stale snapshot (`status=accepted`, `started_at=nil`, `peek=""`,
  `en_route` set) makes the self-heal re-mint a Start OTP.
- **Why it matters:** Lower impact than S-003: a re-minted Start OTP is inert once status flips to
  `in_progress` (the start UPDATE is gated `WHERE status='accepted'`), so the leftover code can never
  start the booking again. It still leaves a stray valid code in Redis until TTL and is the same
  invariant violation.
- **Suggested fix:** Re-read `status, started_at` (or take the End-path SELECT approach) before the Start
  self-heal decision, or explicitly document the inert window in the truth-table comment so the
  asymmetry with the (fixable) End path is intentional and recorded.

### S-008 — CRM cash settle: audit-log write is not transactional with the money UPDATE and its error is ignored
- **Severity:** Low
- **Location:** `internal/crm/cash/cash.go:147-177` (settle UPDATE, autocommit) and `:250-266` (best-effort `recorder` audit write after commit)
- **Description:** The batch settle UPDATE runs as a single autocommit statement (atomic on its own), but
  the `crm_audit_log` insert happens afterward, is gated on `if h.recorder != nil`, and its return value
  is not checked. If the audit insert fails, the money-state change stands with no audit trail.
- **Why it matters:** Weak audit guarantee for a money-handling action — a settle can succeed without a
  corresponding audit row, hampering reconciliation/forensics.
- **Suggested fix:** Wrap the settle UPDATE and the audit insert in one `pgx` transaction (or at minimum
  check and alert on the `Recorder.Log` error) so a settle can never commit without its audit record.

### S-009 — Data-only FCM pushes never prune unregistered tokens; no `fcm_token` uniqueness
- **Severity:** Low
- **Location:** `internal/notification/service.go` `sendDataToTokens` (multicast result ignored, unlike `sendToTokensWithReport`); `migrations/043_device_tokens.up.sql` (uniqueness on `(device_id, platform)`, not `fcm_token`); exercised on every Start/ResolveCash/Complete by `cf538bb`
- **Description:** The `SendData` path used by the new cross-app pushes does not walk the per-token batch
  response to evict `IsUnregistered` tokens, and `device_tokens` has no uniqueness on `fcm_token`, so a
  reassigned/stale token can persist under a former owner and keep receiving pushes (90-day `updated_at`
  window is the only staleness guard).
- **Why it matters:** Misdelivery vector, but bounded: the push payloads carry **no** OTP/amount/PII —
  only `{type, booking_id, status}` — and any recipient still has to pass the owner-scoped `GetTracking`
  IDOR check to see booking content. Pre-existing gap that `cf538bb` newly exercises frequently.
- **Suggested fix:** Route `sendDataToTokens` through the same report-walking + `resolver.DeleteToken`
  prune used by the customer-facing path, and add a `fcm_token` unique constraint with
  `ON CONFLICT (fcm_token) DO UPDATE` so token rotation migrates the row to the new owner.

---

## Informational / notes

- **S-I1 — Dev-seed runtime gate honours the `ENV` alias; repo template ships `ENV=development`.**
  `internal/booking/dev_seed.go:101-108` accepts `APP_ENV` or `ENV == "development"` (alias added in
  `d2ff0d1`), and `.env.example:3` sets `ENV=development`. This is *not* a prod exposure because Gate 1
  (the `//go:build dev` tag, with the prod Dockerfile building with empty `BUILD_TAGS` —
  `Dockerfile:13-16`) keeps the seed code out of the production binary entirely. Note also that
  `ENV=development` already existed on `develop` (pre-Phase-1) and that the broader effect of `ENV` on
  `IsProduction()` (SecurityHeaders/CSRF/OTP-dev-mode) is a pre-existing concern outside this scope. Kept
  as a defence-in-depth note: prefer `.env.example` to ship `ENV=production` and reserve
  `ENV=development` for `.env.local.example`.

- **S-I2 — `jobs.go` en_route/arrived pushes still use bare `_ = s.notifications.SendData(...)`.** `e1e703e`
  added explicit failure logging to the Start/ResolveCash/Complete pushes but left the older en_route /
  arrived pushes in `internal/booking/jobs.go` silently discarding errors. Inconsistent observability;
  apply the same `log.Warn` treatment.

- **S-I3 — OTP attempts-counter TTL stamp is best-effort.** `internal/otp/otp.go:173-175` retries `Expire`
  once and then proceeds; if both fail the counter has no TTL and stays pinned. This *fails closed*
  (over-restrictive, never over-permissive) and the next `Issue` resets state, so it is not a weakness —
  noted for completeness.

- **S-I4 — Lockout takes precedence over a correct code.** `internal/otp/otp.go:162-189` checks the rate
  limit before the constant-time compare, so once `maxVerifyAttempts` is crossed even the correct code
  returns `ErrTooManyAttempts` for the rest of the window. Intentional and correct for a payment gate.

- **S-I5 — Client carries a dead, guessable OTP-derivation path.** `App/zopmop-app/src/screens/main/TrackLiveScreen.tsx:1333-1340`
  (`deriveOtp`, an FNV hash of the booking ID) and its `displayOtp` at `:434` are computed but never
  rendered (the live path at `:765` uses the server-issued code). Harmless today; delete the dead
  `deriveOtp`/`displayOtp`/legacy-`otp` fallback so a future refactor cannot resurrect a forgeable code.

### Out of scope (pre-existing, not a Phase 1 change)
- The Cashfree webhook does not validate `payment_amount` against the booking amount before stamping
  `paid` — pre-existing webhook behaviour (`internal/payments/handler.go` PAYMENT_SUCCESS branch). Phase 1
  only added the booking `payment_status='paid'` stamp + End-OTP issuance inside the already-verified,
  deduped path. Worth a follow-up but not Phase 1.
- `bookings.payment_method` / `payment_status` are bare `VARCHAR(20)` with no value `CHECK`
  (migration 046). The new gate now depends on the literal `'paid'`; consider an enum/CHECK separately.
- `.env.example ENV=development` and the global `IsProduction()` switch predate Phase 1.

---

## What I checked and found clean (positive findings)

- **OTP namespace separation is airtight.** Login keys live exclusively under `otp:login:*`; service OTPs
  under `otp:{start|end}:{bookingID}` with `validScope` locking the scope segment (`otp.go:256-257`). The
  two readers are disjoint over the keyspace — a login `verificationId` cannot satisfy a service-OTP
  verify or vice versa. Proven by `TestLoginNamespaceCannotSatisfyServiceOTP`, `TestCrossScopeRejection`,
  `TestCrossOwnerRejection` (`internal/otp/otp_test.go`).
- **Service-OTP rate-limit key shape collides with no login limiter.** `otp:verify-attempts:{scope}:{owner}`
  shares no prefix with any `otp:login:*` limiter or the IP/user limiters in `middleware/ratelimit.go`;
  per-booking and per-scope isolation are unit-tested.
- **Dev limiter bumps are strictly dev-gated.** `24ba111`'s relaxed limits are inside `if env == "development"`
  in `middleware/ratelimit.go`; an unset/empty/`production` env keeps the hardcoded prod defaults
  (fail-secure).
- **Dev seed harness is excluded from prod.** Build-tag Gate 1 (empty `BUILD_TAGS` in `Dockerfile:13-16`)
  keeps `dev_seed.go` out of the prod binary; the `//go:build !dev` stub keeps the package compiling.
  Gate 3 fails closed on empty `DEV_SEED_KEY` (`dev_seed.go:111-116`), the env gate returns 404 to hide
  existence, the route is per-request gated, and no other code path reaches the seed functions. The
  secret/header is never logged.
- **OTP codes never leak.** No OTP value is logged (the send path explicitly logs only `MaskPhone`),
  returned in an error, or echoed to the client except the double-gated dev `999999` sentinel
  (`auth/service.go` `shouldEchoDevOTP` = dev-mode AND `!isProduction`). The client never logs codes to
  console/analytics/storage; PostHog autocapture is configured with `captureScreens:false`.
- **OTP codes are customer-only on GetTracking.** `service.go:1874` gates every OTP Peek/Issue on
  `requestingUserID == booking.CustomerID` (commit `5ded4cb`); the pro app reads only the
  `*_otp_verified_at` timestamps, never the codes (verified across `screens/pro/*`, `api/jobs.ts`,
  `api/pro.ts`).
- **Cross-app push recipients are correctly scoped.** Every `SendData` target is derived from the
  authoritative booking row already gated on the caller's `helper_id`/`customer_id`; no caller-supplied
  recipient. Payloads carry no OTP/amount/phone/address.
- **WS booking_id buffer fix (`24ba111`) is correct and was not a data leak.** `strings.Clone` copies the
  param out of the recycled fasthttp buffer; the pre-fix corruption could at worst show a user *their own*
  other booking (auth keyed on JWT `user_id`, independent of the param), never a stranger's.
- **Chargeability guard is the sole entry for new booking charges.** `DecideChargeable`
  (`payments/chargeability.go:59`) is called by `createCashfreeOrderForBooking` (`handler.go:477`), the
  only path that opens a booking order; ownership (`bookingCustomerID != userID` → 403) and status are
  checked first, and the refunded → `BOOKING_REFUNDED` 409 rule reaches the handler. Defense in depth with
  the `gateway_status='success'` and reusable-order checks.
- **Cancel truth table forbids cancelling `in_progress`.** `IsCancellableStatus` / `IsCancellable`
  (`model.go`) return false for in_progress (and once en_route/arrived is stamped), with a `default:
  return false` — a customer cannot cancel after service starts to dodge payment. Pinned by
  `cancel_truth_table_test.go`.
- **Completion gate has defense-in-depth.** `CompleteBooking` requires the End OTP **and**
  `(payment_status='paid' OR cash_collected_at IS NOT NULL)` in the same UPDATE (`service.go:2234`); the
  disambiguation SELECT does not leak payment state to unauthorized callers (errors map to generic
  `OTP_INVALID` / typed codes via `mapOTPGateError`, `handler.go:723`).
- **CRM cash endpoints are correctly authorized.** Cash routes sit behind the CRM JWT (separate key set +
  `crm_admin_sessions` check) plus `RequirePermission("cash.read"|"cash.settle")` with a role-rank
  hierarchy; `support` can read but not settle. Settle derives amount/target server-side (no client
  amount), all SQL is parameterized, and settle is monetarily idempotent (partial index on
  `cash_settled_at IS NULL`).
- **Webhook security.** HMAC signature verified on the raw body before any state touch; stale-timestamp
  replay window (`ErrWebhookStale` → 410); event dedup via `ConsumeOnceTx`; `SELECT … FOR UPDATE OF p`
  serializes concurrent deliveries; the candidate signature is never logged (only length + 4-char hint).
  No webhook field is fetched as a URL, so no SSRF/DNS-rebinding surface.
- **Client trusts the server for money and state.** The cash path sends only `bookingId` (no amount);
  end-of-service advancement is server-driven (webhook/poll), not a client "paid" flag; no secrets/keys
  are hardcoded in the changed RN files; the payment screen is not deep-link reachable.

---

*End of report. Advisory only — no code changed, no fixes applied.*
