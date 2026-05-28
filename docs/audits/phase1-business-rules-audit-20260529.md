# Phase 1 Business-Rules Audit — 2026-05-29

**Type:** Read-only / doc-only business-rules audit. No code changed.
**Auditor branch:** `audit/phase1-business-rules` (cut from `feature/otp-namespace-separation`). Do NOT merge.
**Source of truth:** `App/househelp-api/docs/phase-1-payment-gated-flow.md` (the maintained Phase 1 decision record).

## Scope and method

Phase 1 = the union of two branches that **diverged at `3c94546`**:

- `feature/otp-namespace-separation` — complete backend (Steps 0–3 + 5a self-heal + cross-app push + refunded + dev seed). Tip `5680bdd`.
- `feature/pro-app-two-otp-flow` — full app (Steps 4–5) on an **older backend base** (forked before the later backend commits). Tip `3f8e832`.

Because the branches diverged, neither alone contains all of Phase 1. Backend citations below are from `feature/otp-namespace-separation`; app citations (`App/zopmop-app/...`) are from `feature/pro-app-two-otp-flow` tip. **This divergence is itself a finding — see B-022 and "Rules in code without explicit agreement."**

Each backend rule was traced to enforcing code with `file:LINE` citations and cross-checked against pinning tests. Each app rule was traced to the rendering screen / API taxonomy.

### Verdict summary

| Rule | Title | Status |
|------|-------|--------|
| B-001 | Pay-after, not pay-before | ENFORCED |
| B-002 | Customer chooses payment, pro never marks | ENFORCED |
| B-003 | The lock rule (3 branches) | ENFORCED |
| B-004 | One choice closes the other / residual-race guard | ENFORCED (logic) · PARTIAL (test) |
| B-005 | Two-OTP requirement | ENFORCED |
| B-006 | OTP issuance triggers | ENFORCED |
| B-007 | OTP self-heal (Peek-then-Issue) | ENFORCED |
| B-008 | Rate limit (gate-lock, not code) | ENFORCED |
| B-009 | Cancellation truth table | ENFORCED |
| B-010 | Pro never marks cash | ENFORCED |
| B-011 | Cash attribution snapshot | ENFORCED |
| B-012 | Cash vs Cashfree mutual exclusion | ENFORCED (no DB constraint) |
| B-013 | Owes calculation | ENFORCED |
| B-014 | Settle is per-pro batch | ENFORCED |
| B-015 | Payroll decoupling | ENFORCED (denylist caveats) |
| B-016 | Escape hatch / stuck job | ENFORCED (predicate-scope caveat) |
| B-017 | Pay-now-vs-pay-later copy | ENFORCED |
| B-018 | Cash banner unmistakable (pro) | ENFORCED |
| B-019 | Online-prominent / cash-secondary (State 1) | ENFORCED |
| B-020 | Reversed emphasis on cash popup | ENFORCED |
| B-021 | Real-time cross-app updates | ENFORCED |
| B-022 | Deployment coupling / merge order | ENFORCED BY CONVENTION · doc drift |
| B-023 | Refunded is blocked | ENFORCED (backend) · **NOT ENFORCED (app)** |

**Headline:** 21/23 enforced in code with tests. The one material gap is **B-023 on the app side** (refunded code unmapped end-to-end). The highest-leverage structural risks are the **branch divergence** (a security-relevant backend hardening, `5ded4cb`, lives only on the app branch) and the **untested DB-backed ResolveCash guards**.

---

## Payment timing

### B-001 — Pay-after, not pay-before. Booking creation never charges.
**Status: ENFORCED**

- `internal/booking/repository.go:30` — `CreateBooking` is the only booking INSERT; columns are `customer_id, service_category_id, status, address, lat, lng, amount_paise, promo_code, discount_paise`. No payment columns, no gateway call. Status defaults to `StatusPending` (`:33`).
- Cashfree order creation exists only in `internal/payments/handler.go` (`createCashfreeOrderForBooking:413`, `openCashfreeOrder:623`), reached via the payments endpoint — never from booking-create.
- App: Cart no longer collects payment at booking time — `App/zopmop-app/src/screens/main/CartScreen.tsx:91-97` (`// Phase 1 — pay-after model. Cart no longer collects payment at booking time.`).

**Gap:** none in the create path.
**Suggested action:** optional assertion test that `CreateBooking` touches no payment columns.

### B-002 — Customer chooses payment method; the pro never marks payment.
**Status: ENFORCED**

- All payment-state writes are customer- or webhook-reachable only:
  - `cash_collected_at` / `cash_collected_by_pro` — written only at `internal/booking/service.go:461-462` in `ResolveCash`, customer-gated (handler reads `userID` `internal/booking/handler.go:673-681`; query constrained `WHERE id=$1 AND customer_id=$2` `service.go:364`).
  - `payment_status='paid'` — `internal/payments/handler.go:1013-1016` (Cashfree webhook) and `internal/booking/service.go:551-554` (`payBookingFromWallet`, customer wallet rail).
- Pro path `CompleteBooking` (`service.go:2247`, keyed on `helper_id`) only **reads** `payment_status`/`cash_collected_at` as a completion gate (`service.go:2289`); never writes them.
- App: `App/zopmop-app/src/screens/pro/JobDetailScreen.tsx:638-641,805` — `InProgressBody` and `CashCollectBanner` are explicitly read-only (`// Read-only: pro taps NOTHING here.`); the only interactive control is the End-OTP submit (`:747-764`). No pay/collect/mark-cash button.

**Gap:** the **migration-112 comment** (`migrations/112_otp_payment_gates.up.sql:19-21`) wrongly describes `cash_collected_by_pro` as "pro user_id who marked the booking paid by cash" — stale; the real writer is the customer's `ResolveCash`. Doc-only, but a future dev could build a "pro-marks-cash" endpoint on that false premise.
**Suggested action:** fix the stale migration comment.

### B-003 — The lock rule (verify ALL THREE branches).
**Status: ENFORCED**

1. **Online success closes cash** — `ResolveCash` blocks paid-online: `internal/booking/service.go:379-381` `if paymentStat != nil && *paymentStat == "paid" { return ErrAlreadyPaidOnline }` → handler 409 `ALREADY_PAID_ONLINE` (`handler.go:701-704`).
2. **Cash confirmed closes online** — Cashfree order creation blocks on cash: `internal/payments/chargeability.go:60-61` (`BlockedAlreadyPaidCash`) → `internal/payments/handler.go:481-483` (409 `already_paid_cash`).
3. **FAILED online keeps BOTH open** — the failed/dropped webhook branch `internal/payments/handler.go:1044-1051` flips only the **payments ledger row** to `'failed'`; it never touches `bookings.payment_status` or `cash_collected_at`. So `ResolveCash` still passes its paid-check, and `DecideChargeable(failed,nil)=Chargeable` (`chargeability.go:63-71`, asserted `chargeability_test.go:40-43`). Both paths remain open.

**Gap:** branch 3's "failed leaves bookings columns untouched" behavior is asserted by reading code, not by a test.
**Suggested action:** webhook test asserting `PAYMENT_FAILED_WEBHOOK` leaves `bookings.payment_status` NULL.

### B-004 — One choice closes the other; State 5 fallback + residual-race guard.
**Status: ENFORCED (logic) / PARTIALLY ENFORCED (test coverage)**

- After an online failure, cash still resolves (B-003 branch 3).
- Residual-race guard — `internal/booking/service.go:436-452`: `SELECT EXISTS(... payments WHERE booking_id=$1 AND gateway='cashfree' AND gateway_status='pending' AND created_at > NOW() - INTERVAL '2 minutes')`; if present → `ErrOnlinePaymentPending` → 409 `ONLINE_PAYMENT_PENDING` (`handler.go:705-709`). The **2-minute freshness bound** and the `gateway_status='pending'` check are present exactly as the doc specifies (`docs/phase-1-payment-gated-flow.md:25-43`).
- App State-5 fallback (online fail → cash, no friction): the cash-confirmation popup uses reversed emphasis (see B-020) and the failure screen offers cash directly (`EndOfServicePaymentScreen.tsx:427`).

**Gap:** no test exercises the 2-minute bound or the pending check. `internal/booking/cash_resolve_test.go` covers only `TestResolveCash_OTPServiceNotWired` (`:22`); the header (`:5-6`) explicitly defers the DB-backed guards to "a real DB." A future edit changing `2 minutes` → `2 hours`, or dropping the bound, would trap abandoned-payment customers and no test would fail.
**Suggested action:** DB-backed (or repo-mocked) test pinning: fresh pending → `ErrOnlinePaymentPending`; pending older than 2 min → resolves to cash.

---

## OTP gates

### B-005 — Two-OTP requirement.
**Status: ENFORCED**

- START gate — `internal/booking/service.go:1992-2022` (`StartBooking`): `:1996` `if startOTPCode == "" { return ErrStartOTPRequired }`; `:2001` `s.otpSvc.Verify(ctx, otp.ScopeStart, ...)`; UPDATE status-guarded `WHERE id=$1 AND helper_id=$2 AND status='accepted'` (`:2012-2014`).
- COMPLETE gate — `internal/booking/service.go:2247-2314` (`CompleteBooking`): `:2255` `Verify(ctx, otp.ScopeEnd, ...)`; UPDATE guarded `... AND status='in_progress' AND (payment_status='paid' OR cash_collected_at IS NOT NULL)` (`:2284-2289`); `ErrPaymentNotResolved` disambiguation when in_progress-but-unpaid (`:2307-2309`).
- OTP is one-time-consume on success (`internal/otp/otp.go:198`), so no replay.

**Gap:** none.

### B-006 — OTP issuance triggers (neither path issues both).
**Status: ENFORCED**

- **Start OTP** issued only in `MarkEnRoute`: `internal/booking/jobs.go:382` `Issue(ctx, otp.ScopeStart, bookingID)` (post-commit after `en_route_at` stamp `:366-371`).
- **End OTP** on Cashfree success: `internal/payments/handler.go:945` `IssueEndOTP(...)` → `service.go:300` `Issue(ctx, otp.ScopeEnd, ...)`, gated on `bookingPaidID != ""` (PAYMENT_SUCCESS only).
- **End OTP** on ResolveCash: `internal/booking/service.go:476` `Issue(ctx, otp.ScopeEnd, ...)` (post-commit) + idempotent self-heal Peek-then-Issue `:396-408`.
- Confirmed: Start issuance is unique to MarkEnRoute; End issuance unique to the two payment-resolution paths. No path issues both.

**Gap:** none.

### B-007 — OTP self-heal (Peek-then-Issue, idempotent, never regenerate).
**Status: ENFORCED**

- Deciders `internal/booking/self_heal.go`: `DecideStartOTPSelfHeal:70-84` (`:71` skip if `peekedCode != ""`; `:74` skip unless `accepted`; `:77` skip unless `en_route_at`; `:80` skip if `started_at != nil`); `DecideEndOTPSelfHeal:101-112` (`:102` skip if `peekedCode != ""`; `:105` skip unless `in_progress`; `:108` skip unless paid-or-cash).
- `GetTracking` wiring `internal/booking/service.go:1905-1960`: Peek both scopes first (`:1907-1912`, zero-write common path); the tight `SELECT payment_status, cash_collected_at` fires only behind `status==in_progress AND endCode==""` (`:1932-1939`).
- Truth tables pinned: `self_heal_test.go:28` (`TestDecideStartOTPSelfHeal_TruthTable`), `:112` (`TestDecideEndOTPSelfHeal_TruthTable`).

**Gap:** none. (Common path emits zero writes and zero extra SQL, per doc requirement.)

### B-008 — Rate limit (locks the gate, not the customer's code).
**Status: ENFORCED**

- `internal/otp/otp.go` `Verify:154-201`. Constants: `maxVerifyAttempts=10` (`:67`), `verifyAttemptsWindow=5*time.Minute` (`:72`). Key: `attemptsKeyFor:252-254` → `otp:verify-attempts:{scope}:{ownerID}`.
- INCR-first, **early-return-before-compare**: `:167-168` `Incr`; `:177-179` `if attempts > maxVerifyAttempts { return ErrTooManyAttempts }` — returns the 11th attempt **before** the `GET`/`subtle.ConstantTimeCompare` (`:181-191`). The stored code is never consulted on lockout.
- Clear-on-success: `:198-199` `Del(key)` (consume) + `Del(attemptsKey)` (reset).
- Per-`(scope, ownerID)` isolation. Pinned: `otp_test.go:288,322,358,383,427` (lockout, per-booking isolation, scope isolation, reset-on-success, expiry).
- Booking-layer mapping `service.go:2002-2003 / 2256-2257` → 429 `OTP_TOO_MANY_ATTEMPTS`.

**Gap (minor, non-blocking):** the attempts-counter TTL stamp (`otp.go:169-176`) is best-effort with a single retry; only a successful `Verify` clears the counter (`Issue` does not). If both Expire calls fail, the counter could theoretically pin longer than intended.
**Suggested action:** optionally have `Issue` also `Del` the attempts key to bound the worst case.

---

## Cancellation truth table

### B-009 — Who can cancel what when (IsCancellable is the sole source).
**Status: ENFORCED**

- `IsCancellable` — `internal/booking/model.go:67-80`: `nil`→false; `!IsCancellableStatus`→false; if `accepted` AND (`EnRouteAt != nil` OR `ArrivedAt != nil`)→false; else true. `IsCancellableStatus:47-55`: pending/accepted→true; searching/in_progress/completed/cancelled→false; unknown→false.
- Sole-source confirmed: the only customer/pro cancel path is `CancelBooking` → `service.go:925 if !IsCancellable(booking)` (routes `/:id/cancel` + `DELETE /:id`, `handler.go:70-71`). The `CancelBookingWithFee` call sites (`service.go:805,1446,1599`) are **system rollbacks of freshly-created bookings** on wallet/payment failure — never run on a started booking. CRM `Cancel` (`internal/crm/orders/orders.go:375`) is a separate admin tool.
- Accepted-substate guards (commit `2d2fcbd`) confirmed: `en_route_at`/`arrived_at` set while `status='accepted'` → NOT cancellable. Pinned: `cancel_truth_table_test.go:29,56,76` (rows `:97-110`).

**Gap:** none.

---

## Cash safety

### B-010 — Pro never marks cash.
**Status: ENFORCED**

- Only production writer of `cash_collected_at` is `ResolveCash` (`internal/booking/service.go:461-462`, customer-gated). Other hits: `dev_seed.go:225,262,290,348` (dev only); `internal/crm/cash/cash.go:124,153` are reads/filters or write `cash_settled_at`, not `cash_collected_at`. No pro endpoint writes it.

**Gap:** `dev_seed.go` can stamp cash. Acceptable only if dev-seed routes are build/env-gated.
**Suggested action:** confirm dev-seed registration is behind a build tag / env guard (the harness is `//go:build dev` triple-gated per commit `2c8016a` — verify the route mount matches in prod config).

### B-011 — Cash attribution snapshot.
**Status: ENFORCED**

- `internal/booking/service.go:459-465`: `UPDATE bookings SET cash_collected_by_pro=$2::uuid, cash_collected_at=NOW() ... WHERE id=$1` with `$2 = *helperID` read under `SELECT ... FOR UPDATE` at resolve time (`:362-367`). True snapshot of the then-assigned helper; rationale at `:324-326,454-458`.

**Gap:** none (a DB-backed test would harden it — same coverage hole as B-004; `cash_resolve_test.go:5`).

### B-012 — Cash vs Cashfree mutual exclusion.
**Status: ENFORCED (guard-level; no DB constraint)**

- Cash blocks online: `chargeability.go:60-61` → `payments/handler.go:481-483`.
- Online blocks cash: `service.go:379-381` → `handler.go:701-704`.
- Precedence (cash beats paid if both ever set): `chargeability.go:59-71`, asserted `chargeability_test.go:66-70`.

**Gap:** exclusion is enforced by two independent guards, **not** a DB constraint. No CHECK/partial-unique makes `payment_status='paid'` and `cash_collected_at IS NOT NULL` impossible to coexist. A future path bypassing both guards could produce a row holding both.
**Suggested action:** add a table-level CHECK / partial-unique enforcing at most one of {paid-online, cash-collected}.

### B-013 — Owes calculation.
**Status: ENFORCED**

- `internal/crm/cash/cash.go:117-127` (`GetProOwes`): `b.amount_paise - COALESCE(b.discount_paise,0) ... WHERE b.cash_collected_by_pro=$1 AND b.cash_settled_at IS NULL`.
- Aggregate `ListOwes:83-96`: `SUM(b.amount_paise - COALESCE(b.discount_paise,0)) ... WHERE b.cash_settled_at IS NULL`. Formula matches the rule exactly (with defensive COALESCE).

**Gap:** `cash_collected_by_pro` references `users(id)` (migration 112:37) but `ListOwes` `INNER JOIN helpers h ON h.id = b.cash_collected_by_pro` (`cash.go:92`). If `helpers.id` and `users.id` are different key spaces, the inner join would silently drop owed rows from the dashboard total.
**Suggested action:** confirm `helpers.id == users.id`; if they can differ, use a LEFT JOIN / correct key so no unsettled cash is hidden.

### B-014 — Settle is per-pro batch (no partial settle).
**Status: ENFORCED**

- `internal/crm/cash/cash.go:147-156` (`Settle`): single `UPDATE bookings SET cash_settled_at=NOW(), cash_settled_by_admin=$2 ... WHERE cash_collected_by_pro=$1 AND cash_settled_at IS NULL`. One statement flips all unsettled rows for the pro; no per-booking selector exists. Handler `:226-268` takes only `:proID`, gated by `cash.settle` permission; zero rows → 404 `NOTHING_TO_SETTLE` (`:173-175,238-241`).

**Gap:** none.

---

## Pro payroll decoupling

### B-015 — Salaried pros, decoupled.
**Status: ENFORCED (with denylist caveats)**

- Grep-style test `internal/payroll/decoupling_test.go:34-44` denylist: `payment_status, payment_method, cash_collected, cash_settled, internal/payments, internal/wallet, internal/crm/cash, PaymentMethod, Cashfree`. Check `:73-77` substring-matches each `.go` file's full body; fails if zero files scanned (`:80-82`).
- **Catches imports?** YES for the three listed packages — the raw import path string (`.../internal/payments`, `internal/wallet`, `internal/crm/cash`) contains the forbidden substring regardless of alias. The match runs over the full body (no comment-stripping despite the docstring claim), so it is stricter, not weaker.
- Independent grep of non-test payroll files: ZERO forbidden references; imports are stdlib + `zerolog` + `pgx` only — no `internal/` package imported.

**Gap:** (1) substring denylist won't catch a **transitive** import (payroll → helperpkg → payments). (2) A future payment package under a different name (`internal/billing`, `internal/settlement`) would slip through. (3) Docstring (`:32-33`) falsely claims comment-stripping.
**Suggested action:** optional AST/`go/packages` transitive-import assertion (forbid payroll's import graph from reaching payments/wallet/crm-cash); fix the docstring. Not blocking for pilot.

---

## Escape hatch

### B-016 — Stuck-job path.
**Status: ENFORCED (with a minor predicate-scope caveat)**

1. **Pro cannot self-cancel in-progress.** `IsCancellable` returns false for `in_progress` (`model.go:51,67-80`). The cancel route (`handler.go:70-71`) has no proChain restriction and `GetBookingByID` allows both customer and assigned helper (`repository.go:86-90`), so a pro *can reach* `CancelBooking` — but `IsCancellable` blocks `in_progress` regardless of caller (`service.go:925`). No pro-only cancel route bypasses it (pro routes are accept/arrived/start/complete, `handler.go:77-80`).
2. **Admin force-complete → completed+unpaid.** `internal/crm/orders/orders.go:387-398` (`MarkComplete`): `UPDATE bookings SET status='completed', completed_at=now() ... WHERE id=$1 AND status NOT IN ('completed','cancelled')` — sets status only, does **not** touch `payment_status`. Route `:669` `POST /orders/:id/complete`, `RequirePermission("orders.complete")`.
3. **Unpaid force-complete flags the customer.** `GetUnpaidBookingsForCustomer` — `repository.go:519-537`: `WHERE customer_id=$1 AND status='completed' AND payment_method='cashfree' AND payment_status IS DISTINCT FROM 'paid'`. Blocks re-booking (`service.go:699-705`) and account deletion (`auth/repository.go:318-323`); surfaces `UNPAID_BOOKINGS` 409 (`handler.go:141-148`).
- App escape hatch UI: `App/zopmop-app/src/screens/pro/JobStuckScreen.tsx` (State E support `tel:` path) and no in-progress cancel CTA on the pro side (B-002).

**Gap (minor):** the block predicate is scoped to `payment_method='cashfree'`. A force-completed booking with `payment_method` still NULL (webhook never stamped it, or a COD/legacy row) would NOT flag. The normal Cashfree flow stamps `method='cashfree'` at creation (`service.go:602-610`), so the common case is covered.
**Suggested action:** broaden the unpaid predicate to also catch `payment_method IS NULL AND cash_collected_at IS NULL` completed rows, or have `MarkComplete` flag unpaid completions explicitly.

---

## UI / behavioral rules

### B-017 — Pay-now-vs-pay-later mental model.
**Status: ENFORCED**

- **Cart** `CartScreen.tsx`: `:577` "You'll pay ₹{...} when the service is done"; `:580` "Cash or online — choose at the end."; pre-payment picker removed (`:91-97`).
- **TrackLive** `TrackLiveScreen.tsx`: `:791` "You pay when the service is done"; `:794` "When you see your pro packing up, tap below to pay."; CTA `:821` "Pay for this service"; expectation card + CTA hide once paid/cash (`:785-786,806-807`); no-show copy `:650` "...You haven't been charged."
- **End-of-service** `EndOfServicePaymentScreen.tsx`: `:258` "Service complete"; `:293-294` "Pay securely — you're only charged now that the service is complete."; failure copy `:427` "...₹{...} hasn't been charged. Try again or pay with cash."
- Pro framing: `src/i18n/en.ts:176` `awaitingPaymentSub: 'Customer will pay at the end of service.'`
- No leftover `"you will be charged"` / `"Total to pay"` / `"Payment: Paid"` / `"Pay now"` on any pre-completion customer surface.

**Gap (cosmetic, low risk):** Cart `:562-564` renders a bill row literally labelled "Total ₹X" above the pay-after card. It is a bill summary, not a pay-now CTA, but is the only bare "Total" pre-completion. Customer copy here is **hardcoded inline**, not in `en.ts`/`hi.ts` (these screens pre-date the i18n convention — `EndCodeCard.tsx:50-53`).
**Suggested action:** optionally relabel to "Total (due after service)".

### B-018 — Cash banner is unmistakable (pro side).
**Status: ENFORCED**

- `JobDetailScreen.tsx:674-690` picks kind: `isPaidOnline = payment_status==='paid'`; `isCashCollected = !!cash_collected_at`; `payChipKind = isPaidOnline ? 'paid' : isCashCollected ? 'cash' : null`. Banner gate `:708` `{isCashCollected && !isPaidOnline && <CashCollectBanner/>}`.
- Distinction via explicit non-optional tokens: **Cash** = bold amber SVG gradient `#FFC042→#F5A300→#E88F00` (`:811-834`, style `cashBanner:1112-1120 backgroundColor:'#F5A300'`); **Paid online** = quiet green pill (`PayChip:786-799`, `bg rgba(34,197,94,0.14)`, `#22C55E`, `check-circle`). Comment `:809-810` "...unmistakably the loudest thing on the screen when cash is owed."

**Gap:** none.

### B-019 — Online-prominent / cash-secondary on State 1.
**Status: ENFORCED**

- `EndOfServicePaymentScreen.tsx` `ChooseState:244-298`. **Primary "Pay online"** `:268-283` `style={s.primaryBtn}` (`:481-487` full-width 60px amber gradient), bold `fontExtra`. **Secondary cash** `:286-288` `style={s.ghostBtn}` (`:497-508` `rgba(255,255,255,0.06)`, 48px, muted), label "Pay with cash instead" (`// SECONDARY ... Quiet ghost.` `:285`).

**Gap:** none.

### B-020 — Reversed emphasis on cash-confirmation popup.
**Status: ENFORCED**

- `EndOfServicePaymentScreen.tsx` `CashConfirmPopup:306-370` (header `:301-304` documents the reversal). **Loud "Pay online instead"** `:334-351` `style={s.popupPrimaryBtn}` (`:539-547`, amber gradient, `fontExtra`). **Quiet "Yes, pay cash"** `:355-366` `style={s.popupQuietBtn}` (`:549-554`, no background, `fontMed rgba(255,255,255,0.55)`). Emphasis reversed vs State 1.

**Gap:** none.

---

## Cross-app handoff

### B-021 — Real-time updates (SendData on Start/ResolveCash/Complete, non-fatal + logged).
**Status: ENFORCED**

- Interface `internal/booking/service.go:172`. All three sites nil-guarded, error captured, `log.Warn().Err(...)`, NOT returned:
  - ResolveCash `:503-512` (push to pro, `booking_status_change`).
  - StartBooking `:2038-2047` (push to customer).
  - CompleteBooking `:2382-2391` (push to customer).
- App consumes it: `ActiveBookingPill.tsx:144-150` refetches on `onShiftEvent ev.type==='booking_status_change'`; "live" derived from the `getBookings(...,'upcoming')` payload via `pickLiveBooking():61-88`, hidden when null (`:154`); backstops `useFocusEffect:122` + 30s interval `:125-128`. Pro side same event `JobDetailScreen.tsx:136-142`.

**Gap:** none functional. Logged at `Warn`, so a broken FCM path relies on warn-level alerting being configured.
**Suggested action:** optional push-failure metric.

### B-023 — Refunded is blocked (predicate + handler + frontend agree).
**Status: ENFORCED (backend) / NOT ENFORCED (app)**

- **Backend predicate:** `internal/payments/chargeability.go:67-68` `case "refunded": return BlockedRefunded` (asserted `chargeability_test.go:58,92`).
- **Backend handler:** `internal/payments/handler.go:484-489` → 409 code `booking_refunded`, message "this booking was refunded — contact support to re-collect".
- **App mapping — MISSING:**
  1. `EndOfServicePaymentScreen.tsx` never handles `booking_refunded`. Its only error switch is on `ResolveCashError.code` (`:129-166`), and `ResolveCashErrorCode` (`bookings.ts:201-207`) does not include `booking_refunded`.
  2. The end-of-service "Pay online" button is still a **mock** — `:93 const tapPayOnline = () => setState('opening')` — it never calls `createCashfreeOrder`, so the screen never receives the error (5d.2.c/d not yet wired, `:74`).
  3. The real `createCashfreeOrder` call (`PaymentScreen.tsx:118-135`) does not branch on `err.code === 'booking_refunded'`; it surfaces a generic `err.message`. The only "refunded → contact support" copy (`:164`) is bound to the **poll-status** path, not the chargeability error.
  4. The code `booking_refunded` is declared in `bookings.ts:216,233` (type `CreateCashfreeOrderErrorCode`) but **no runtime `=== 'booking_refunded'` comparison exists anywhere** — so there is no casing mismatch yet, but also no enforcement. (When wired, must match backend's lowercase `booking_refunded`, not `BOOKING_REFUNDED`.)

**Gap:** a refunded booking reaching the end-of-service online-pay flow yields a no-op mock or a generic error — never the "contact support to re-collect" outcome the rule requires.
**Suggested action:** when `tapPayOnline` is wired to `createCashfreeOrder` (5d.2.c), add `case 'booking_refunded'` (lowercase) showing a persistent "This booking was refunded — contact support to re-collect" message; mirror in `PaymentScreen.tsx`'s catch.

---

## Merge order

### B-022 — Deployment coupling ("apps first, backend last").
**Status: ENFORCED BY CONVENTION ONLY (doc-recorded) — with doc drift + a live divergence risk**

- Doc still records it: `docs/phase-1-payment-gated-flow.md:112-145` ("MANDATORY merge order" — ship pro + customer apps first, then backend; `400 OTP_REQUIRED` strands old builds; "Reverse order = silent regression"). The technical backstop named is the existing `min_app_version` server check (`:128`).
- Code direction corroborates apps-first: the backend gate is additive/stricter (requires an OTP body only new apps send); the matching/dispatch/customer-list changes are all **widening** predicates (more permissive), never requiring new app behavior.

**Gaps:**
1. **Live branch divergence (highest-value structural finding).** Commit `5ded4cb` ("gate start/end OTP codes to customer-only on `GetTracking`", a 9-line **backend** `service.go` change) lives **only on `feature/pro-app-two-otp-flow`**, NOT on `feature/otp-namespace-separation`. The backend branch's `GetTracking` (`service.go:1844-1962`) peeks/issues codes with **no customer-vs-helper guard** — i.e. it returns the OTP codes to the pro too. If the documented merge order treats `feature/otp-namespace-separation` as "the backend" and merges it, this customer-only hardening would be **absent** unless the app branch's backend delta also lands. The two branches must be reconciled before the backend merges, or the security gating regresses.
2. **Stale docstring** `internal/matching/scheduled_dispatch.go:145-150` advertises a `AND (payment_method != 'cashfree' OR payment_status='paid')` gate that the live query (`:188 AND true`) no longer applies — directly contradicts the new inline comment 30 lines below and the accepted-risk decision. Behavior is correct; the comment is wrong.
3. `min_app_version` cutover check is referenced by the doc but not independently verified wired in this audit.

**Suggested action:** reconcile the `5ded4cb` backend delta into `feature/otp-namespace-separation` (or merge both branches' backend together) before the prod backend merge; fix the stale `scheduled_dispatch.go` docstring; verify `min_app_version` is wired before cutover.

---

## Suspected rules with no code enforcement (highest-value findings)

1. **B-023 app mapping (NOT ENFORCED).** `booking_refunded` is unmapped on every customer surface; the only refund copy is bound to the wrong (poll) signal. Agreed behavior ("contact support to re-collect, not silent close") exists in agreement and backend, but not in the app. *Caveat: the end-of-service online-pay button is still an unwired mock (5d.2.c pending), so this is a not-yet-built surface rather than a regression — but it must be built to the rule.*
2. **B-012 has no DB-level guarantee.** Cash/online mutual exclusion is enforced only by two code-path guards; the schema permits a row with both states. Agreed invariant, no structural enforcement.
3. **B-004 / B-011 / B-003-branch-3 untested.** The DB-backed `ResolveCash` guards (2-minute residual-race bound, helper snapshot, paid-online block) and the failed-webhook-leaves-columns-untouched behavior have **no automated test** (`cash_resolve_test.go:5-6,22` defers them to "a real DB"). Enforced by code + review only — silent regression risk on edit.
4. **B-022 merge order + `5ded4cb` divergence.** Process rule, machine-unenforced; compounded by a security-relevant backend change living only on the app branch (see B-022 gap 1).

## Rules in code without explicit agreement (flag for review)

1. **Customer-only OTP-code gating on `GetTracking`** (`5ded4cb`, app branch). The doc never states the pro must be denied the raw OTP codes via TrackLive's payload — yet the app branch's backend now gates them customer-only. Good guard, but undocumented and (per B-022) not on the backend branch. Decide whether this is a Phase 1 decision and land it on the backend lineage.
2. **Wallet payment rail** (`payBookingFromWallet`, `service.go:551-554`) sets `payment_status='paid'`. The decision doc discusses only Cashfree + cash; a wallet rail that also closes the payment is a third path not described in the Phase 1 model. Confirm it is intended in scope and that it interacts correctly with the lock rule (B-003).
3. **Account-deletion block on unpaid bookings** (`auth/repository.go:318-323`) extends the unpaid-booking block beyond re-booking to account deletion. Sensible, but not in the decision doc.
4. **CRM `Cancel` admin tool** (`internal/crm/orders/orders.go:375`) refuses `completed`/`cancelled` — a second cancellation surface outside `IsCancellable`. Confined to admin; behavior consistent, but worth noting it is a separate predicate from the pinned truth table (B-009).

## Decisions deferred to "post-pilot" (do not forget)

From `docs/phase-1-payment-gated-flow.md`:

1. **CRM cash React screens (Step 3.B)** — `:98-110`. Endpoints exist (`/crm-api/cash/owes`, `/owes/:proID`, `/owes/:proID/settle`); the React screens in `App/zopmop-crm/` are "explicitly scheduled, not indefinitely deferred." Until then the founder hits endpoints directly each evening.
2. **Matched-but-never-paid mitigations** — `:177-189`. Pre-authorisation hold (needs a Cashfree product the Drop SDK doesn't expose) and the aggregate "pro hours on completed-and-unpaid / total" metric (re-evaluate if >~5% steady-state) are explicitly **"do NOT build now."** Accepted pilot cost; revisit at scale. (Code matches doc — confirmed widened predicates at `matching/engine.go:395-404`, `scheduled_dispatch.go:174-188`, `repository.go:648-651`, `repository.go:812-820`.)
3. **At-scale cash proof model** — `:64-66`. In-app pro receipt confirmation / dual acknowledgement / signed digital receipt. Phase 1 accepts operational (not technical) enforcement of cash receipt. Revisit beyond initial geography.
4. **`useColors()` → `useC()` migration** — `:68-96`. Non-blocking tech debt; mechanical migration only if `feature/appearance-and-location-toast` merges to `develop`. No blocker either way.

### Doc-maintenance note (not a code finding)
`docs/phase-1-payment-gated-flow.md:359` ("**Status.** Not yet implemented") under "End-OTP self-heal on TrackLive load (original spec)" is stale — the self-heal **was** implemented (Step 5a.1, commit `8d7d1dd`), as the newer section `:287-325` documents. The two sections now contradict each other. Recommend deleting/annotating the stale "Not yet implemented" line so the record reads true.
