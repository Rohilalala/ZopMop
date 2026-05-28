# Phase 1 Money-Flow Audit — 2026-05-29

**Scope:** `feature/otp-namespace-separation` + `feature/pro-app-two-otp-flow`,
everything since `develop`.
**Mode:** READ-ONLY, doc-only. No code changed.
**Branch:** `audit/phase1-money-flow` (off `feature/otp-namespace-separation`). Not merged.
**Auditor lens:** correctness of the *money*, not of the code.

Commit range enumerated via `git log develop..<branch>`. The backend money
files are identical across both branches (the pro-app branch only adds RN
screens on top of the same backend); citations use the backend paths.

---

## Summary

Phase 1 moves payment from booking-time to end-of-service and gates service
completion behind a two-OTP flow + payment resolution. The core skeleton is
sound: the End-OTP gate is genuinely load-bearing (`CompleteBooking` SQL
predicate enforces `payment_status='paid' OR cash_collected_at IS NOT NULL`),
payroll is hard-decoupled from payment state, and the `CreateCashfreeOrder`
chargeability guard blocks the obvious double-charge surfaces.

But there are **two money-moving defects that should block the pilot**, both
arising from a single root cause — `bookings.payment_status='paid'` and the
cash stamp are written by paths that don't check each other, and the online
"paid" stamp is gated on `payment_method='cashfree'` which several create paths
never set.

| ID | Title | Severity |
|----|-------|----------|
| M-001 | Cash-first → late-online webhook = customer paid twice | **Launch-blocker** |
| M-002 | Scheduled / cart bookings never stamped `payment_method='cashfree'` → online pay can't complete + escapes the unpaid block | **Launch-blocker (scope-dependent)** |
| M-003 | `BlockedRefunded` branch is unreachable — nothing writes `bookings.payment_status='refunded'` | Reconciliation gap |
| M-004 | `mark-attempt-failed` (5d.2.d) is not implemented in scope; freshness-window safety leans on a webhook that may not fire | Pilot-risk |
| M-005 | Chargeability guard is read-then-write, not DB-atomic — two concurrent orders possible | Pilot-risk |
| M-006 | Webhook never landing → booking stuck unpaid forever, no auto-reconcile | Post-pilot |
| M-007 | Revenue double-count in reconciliation when M-001 fires | Reconciliation gap |

Checked clean: double-cash, cash-twice, force-complete→block (for cashfree),
payroll decoupling, settle-twice, End-OTP self-heal cannot issue on unpaid.

---

## Launch-blockers

### M-001 — Cash-first then late-succeeding online payment double-charges the customer
**Severity:** Launch-blocker
**Files:**
- `internal/booking/service.go:431-447` (ResolveCash residual-race guard, 2-min window)
- `internal/payments/handler.go:1013-1024` (webhook stamps `payment_status='paid'`)

**Description.** `ResolveCash` lets a customer fall back to cash only if there
is no Cashfree order in `gateway_status='pending'` *younger than 2 minutes*:

```
AND gateway_status = 'pending'
AND created_at     > NOW() - INTERVAL '2 minutes'   -- service.go:439
```

Anything older is treated as abandoned and cash is allowed. The webhook's
success path, however, stamps the booking paid with **no check on
`cash_collected_at`**:

```
UPDATE bookings SET payment_status = 'paid' ... WHERE id = $1 AND payment_method = 'cashfree'  -- handler.go:1016
```

Sequence that double-charges:
1. Customer opens the Cashfree sheet → pending `payments`/`cashfree_orders` row.
2. UPI collect is slow / customer waits >2 min, then backs out and chooses cash.
3. `ResolveCash` passes the freshness guard (order now >2 min old), stamps
   `cash_collected_at` + `cash_collected_by_pro`, issues the End OTP.
4. The original UPI mandate settles late → Cashfree fires `PAYMENT_SUCCESS_WEBHOOK`
   → `payment_status='paid'` stamped, ledger row `gateway_status='success'`.

The booking now has **both** `cash_collected_at` set **and**
`payment_status='paid'`. The customer paid the pro cash *and* was charged
online. Nothing unwinds either.

**Why it matters.** Direct customer financial harm, the worst failure class for
a pay-after model. Also corrupts reconciliation (M-007): the cash owes-ledger
*and* the online revenue both count this booking.

**Suggested fix.** Make the writes mutually exclusive at the DB. Webhook stamp
should refuse when cash is already collected:
`... WHERE id=$1 AND payment_method='cashfree' AND cash_collected_at IS NULL`,
and when it finds cash already collected, route the gateway settlement to an
auto-refund instead of stamping paid. Symmetrically, `ResolveCash` should hold
a lock that the webhook also takes on the same row before either commits (today
they lock different tables — the booking row vs the payment row — so they do
not actually serialise against each other despite the comment at service.go:349-354).

---

### M-002 — Scheduled and cart-instant bookings are never tagged `payment_method='cashfree'`
**Severity:** Launch-blocker (severity depends on whether these create-paths are in the pilot)
**Files:**
- `internal/booking/service.go:563-571` (`stampBookingDirectPay` — the only writer of `payment_method='cashfree'`)
- `internal/booking/service.go:782` (CreateBooking — *does* stamp)
- `internal/booking/service.go:1417` (CreateScheduledBooking — does **not** stamp)
- `internal/booking/service.go:1570` (CreateInstantBookingFromCart — does **not** stamp)
- `internal/payments/handler.go:1016` (webhook stamp scoped `WHERE payment_method='cashfree'`)
- `internal/booking/service.go:2234` (CompleteBooking payment gate)
- `internal/booking/repository.go:511-524` (unpaid-block predicate, also `payment_method='cashfree'`)

**Description.** Only `CreateBooking` (instant single-service, `POST /bookings`)
calls `stampBookingDirectPay`. `CreateScheduledBooking` (`POST /bookings/scheduled`)
and `CreateInstantBookingFromCart` (Zop AI cart tool) take the non-wallet branch
and call only `recordPaymentIntent` (a `gateway='cod'` ledger placeholder) — they
leave `bookings.payment_method = NULL`.

Every downstream money check is keyed on `payment_method='cashfree'`:

1. **End-of-service online pay can't complete.** The webhook's
   `SET payment_status='paid' WHERE ... payment_method='cashfree'` updates **0 rows**
   for these bookings, so `payment_status` stays NULL. `CompleteBooking`'s gate
   (`payment_status='paid' OR cash_collected_at IS NOT NULL`, service.go:2234)
   then fails with `ErrPaymentNotResolved` — even though the customer paid and
   the End OTP was issued (the post-commit `IssueEndOTP` at handler.go:944 fires
   off `bookingPaidID`, which is set unconditionally regardless of the stamp).
   Result: **customer charged, pro stuck, cannot finish the job.**
2. **Escape-hatch hole.** A force-completed (or webhook-missed) scheduled/cart
   booking that never paid is invisible to `GetUnpaidBookingsForCustomer`
   (predicate requires `payment_method='cashfree'`, repository.go:522), so the
   re-booking / account-deletion block never fires → revenue leak.

**Why it matters.** Either the customer can't be served (1) or revenue silently
leaks (2), depending on path. Both are money-correctness failures.

**Scope caveat.** Severity is launch-blocker **iff** scheduled bookings or the
Zop cart tool are enabled in the pilot and reach the end-of-service Cashfree
flow. If the pilot is instant-`CreateBooking`-only, demote to Pilot-risk but
fix before enabling those paths.

**Suggested fix.** Stamp `payment_method='cashfree'` in all three non-wallet
create paths (or default the column), so the online-paid stamp, the completion
gate, and the unpaid block all see the booking.

---

## Pilot-risk

### M-004 — `mark-attempt-failed` (5d.2.d) is not in scope; freshness safety leans on a webhook that may not arrive
**Severity:** Pilot-risk
**Files:** `internal/booking/service.go:415-447` (residual-race rationale)

**Description.** The audit prompt references a `mark-attempt-failed` endpoint
(Step 5d.2.d) that should cancel an in-flight Cashfree order before cash
fallback. Grep finds no such handler in either branch (commits stop at 5d.2.b).
The 2-minute freshness window's correctness depends on
`PAYMENT_USER_DROPPED_WEBHOOK` reliably flipping a `pending` order to `failed`
(service.go:421-430). If that webhook is delayed past 2 minutes or never fires,
the customer falls through to cash with a live order outstanding — directly
feeding M-001.

**Why it matters.** The intended client-side mitigation for the M-001 race
does not exist yet, so the only protection is a time heuristic plus a gateway
webhook with no contractual delivery guarantee.

**Suggested fix.** Implement an idempotent client-driven
"abandon this order" call that cancels/expires the Cashfree order server-side
before `ResolveCash` is offered, and make it idempotent (no-op if the order
already terminal). Until then, M-001 must be fixed at the webhook-write level.

---

### M-005 — Chargeability guard is read-then-write, not DB-atomic
**Severity:** Pilot-risk
**Files:** `internal/payments/handler.go:437-512` (createCashfreeOrderForBooking)

**Description.** `createCashfreeOrderForBooking` does a plain `SELECT`
(`payment_status`, `cash_collected_at`) with **no `FOR UPDATE`**, runs
`DecideChargeable`, then later `findReusableCashfreeOrder` + an
`EXISTS(... gateway_status='success')` check, then opens the order. Two
concurrent requests for the same booking can both pass every guard and create
two distinct `cashfree_orders` rows.

**Why it matters.** A customer with two app instances (or a double-tap across a
retry) could be presented two payable sessions. Only one can settle in a given
flow, and the second order expires, so the practical double-charge risk is
low — but it is not *impossible*, and the guard's docstring claims the
double-charge is "IMPOSSIBLE regardless of what any frontend does"
(chargeability.go:15), which overstates the actual guarantee.

**Suggested fix.** Take `SELECT ... FOR UPDATE` on the booking row across the
charge decision + order insert, or add a partial unique index enforcing at most
one open order per booking.

---

## Post-pilot

### M-006 — Webhook never landing leaves the booking unpaid forever with no auto-reconcile
**Severity:** Post-pilot
**Files:** `internal/payments/handler.go:923-936` (dispatch failure → 200, dedupe rolled back); `internal/payments/handler.go:746-763` (status-poll live fetch)

**Description.** If `PAYMENT_SUCCESS_WEBHOOK` never arrives and the status-poll
live fetch also fails, the booking stays `payment_status=NULL`. This is partly
*intentional* — the unpaid-block (for cashfree bookings) then guards the
customer. But there is no reconciler that proactively pulls terminal status
from Cashfree for stuck-pending orders. The `event_outbox` drainer is
explicitly "future work" (handler.go:1076).

**Why it matters.** Money the customer actually paid can sit unrecognised until
the customer hits the re-booking block and complains. Acceptable for a small
pilot with manual ops, not for scale.

**Suggested fix.** Add a periodic reconcile job that `FetchOrder`s all
`gateway_status='pending'` orders older than N minutes and applies terminal
status (the live-fetch logic already exists in `GetCashfreeOrderStatus`).

---

## Reconciliation gaps

### M-003 — `BlockedRefunded` is unreachable; refund state is invisible on the booking row
**Severity:** Reconciliation gap
**Files:**
- `internal/payments/chargeability.go:35-41,67` (BlockedRefunded)
- `internal/payments/handler.go:1053-1066` (REFUND webhook → `payments.gateway_status='refunded'` only)
- `internal/crm/refunds/refunds.go:312-382` (approveUpdate → `pending_refunds` only)

**Description.** Nothing writes `bookings.payment_status='refunded'`. A grep of
all `bookings ... payment_status = '...'` writers finds only `'paid'` (webhook
handler.go:932 + wallet service.go:246). The refund flow updates
`pending_refunds` and `payments.gateway_status`, never the booking. Therefore
`DecideChargeable`'s `BlockedRefunded` branch (chargeability.go:67) and the
`ResolveCash` refunded handling can never trigger.

**Net effect on safety:** *not* a double-charge hole — a refunded booking keeps
`payment_status='paid'`, so a re-charge attempt is caught by
`BlockedAlreadyPaidOnline` and a re-cash by `ErrAlreadyPaidOnline`
(service.go:379). But:
- The chargeability taxonomy is partly dead code, and its docstring promises a
  refunded-routing behaviour that does not exist.
- **Reconciliation cannot distinguish refunded from paid by reading `bookings`** —
  you must join `pending_refunds` / `payments`. "Total revenue" computed off
  `bookings.payment_status='paid'` over-counts by the refunded set.

**Suggested fix.** On refund settlement, also stamp `bookings.payment_status='refunded'`
(or a dedicated `refunded_at`), and make `DecideChargeable` reachable — or
delete the `BlockedRefunded` branch and document that refund state lives only in
`pending_refunds`.

### M-007 — Revenue double-count when M-001 fires
**Severity:** Reconciliation gap (consequence of M-001)
**Description.** When a booking ends up both cash-collected and online-paid, it
is summed once in the CRM owes-ledger (`internal/crm/cash` ListOwes, cash.go:82-96)
and once in online revenue (`bookings.payment_status='paid'` / `payments`
`gateway_status='success'`). End-of-day totals over-count by the overlap with
no field flagging the conflict. Fixing M-001 closes this.

---

## Checked clean

- **Double-cash on one booking.** `ResolveCash` idempotency guard
  (`cash_collected_at != nil → idempotent return`, service.go:392-413) under
  `SELECT ... FOR UPDATE` (service.go:361-366). Cannot stamp twice.
- **Cash settled twice.** `Settle` (cash.go:147-177) flips only
  `cash_settled_at IS NULL` rows; a second run flips 0 → `ErrProNotFound` (404).
  Idempotent. Action is audited (cash.go:250-266). Admin targets a `proID`
  param — settling the wrong pro requires passing the wrong id and is logged.
- **`owes` math.** `SUM(amount_paise - COALESCE(discount_paise,0))` over
  `cash_settled_at IS NULL` grouped by `cash_collected_by_pro` (cash.go:88-95).
  Attribution is snapshotted at resolve time into `cash_collected_by_pro`
  (service.go:454-460), so a later helper reassignment can't shift owed money.
- **End-OTP gate is load-bearing.** `CompleteBooking` requires a verified,
  one-time-consumed End OTP **and** the SQL predicate
  `payment_status='paid' OR cash_collected_at IS NOT NULL` in the UPDATE WHERE
  (service.go:2200-2234). No completion path skips it except admin
  force-complete.
- **Force-complete is the only sanctioned bypass and produces the right state**
  *for cashfree bookings*. `orders.MarkComplete` (orders.go:388-401) sets
  `status='completed'` only, leaving `payment_status`/`cash_collected_at`
  untouched → `completed + unpaid`, which the unpaid block catches (for
  `payment_method='cashfree'`; see M-002 for the gap on other methods). Gated by
  `orders.complete` permission (orders.go:669).
- **End-OTP self-heal cannot issue on an unpaid booking.**
  `DecideEndOTPSelfHeal` requires `status=in_progress` AND (`paid` OR `cash`)
  (self_heal.go:101-112); it never regenerates an existing code (peek-first).
  Start-OTP self-heal is `accepted`-only and customer-gated (service.go:1874).
- **OTP reads are customer-only.** `GetTracking` gates all OTP peek/issue on
  `requestingUserID == booking.CustomerID` (service.go:1874), so the pro can't
  read the codes and bypass the gate.
- **Pro payroll decoupling holds absolutely.** `internal/payroll/calc.go` is a
  pure function of online + working minutes (calc.go:86-101); no payment/cash
  columns referenced; `decoupling_test.go` enforces via source grep. Cash and
  pro pay are separate ledgers and never net. A customer's non-payment cannot
  reduce a salaried pro's earnings. `pro_earnings_paise` is snapshotted at
  completion (service.go:2274-2283) independent of how/whether the customer paid.
- **Wallet path stamps both fields atomically** (`payment_method='wallet'`,
  `payment_status='paid'`, service.go:512-520) inside the debit tx, so wallet
  bookings are correctly seen as paid and are not subject to M-002.
- **No charge at booking time.** Create paths open no Cashfree order; they only
  insert a pending ledger placeholder + (for instant) stamp `cashfree`. The pre-
  payment selector was removed (commit `93e3754`). Charging happens only via the
  end-of-service `CreateCashfreeOrder` / wallet debit.

---

## Out of scope / pre-existing

- The `event_outbox` `booking.paid` / `wallet.topped_up` rows have no drainer
  (handler.go:1076) — pre-existing eventing gap, not introduced by Phase 1.
- Promo discount math (`discountCents`) and the `pending_refunds` table predate
  Phase 1; Phase 1 only reads them.
- Cancellation-fee stamping (`CancelBookingWithFee`) is unchanged by Phase 1.

---

## Decisions Phase 1 made that I can't verify from code alone

1. **Is the scheduled / Zop-cart create path enabled in the pilot?** This
   decides whether M-002 is a launch-blocker or merely latent. Code allows those
   paths to reach end-of-service Cashfree; only product config / pilot scope
   says whether they're live.
2. **Is the 2-minute freshness window (service.go:439) the right value?** It
   trades "trap the customer who abandoned online and now wants cash" against
   "let a slow-settling UPI double-pay" (M-001). Picking 2 min correctly needs
   real UPI-collect settlement-latency data, which isn't in the repo.
3. **Does Cashfree reliably fire `PAYMENT_USER_DROPPED_WEBHOOK` within the
   window?** The whole abandoned-order detection (and thus M-001 likelihood)
   rests on this gateway behaviour. Not verifiable from code.
4. **"Matched-but-never-paid pro time is an accepted pilot cost" — is it
   observable anywhere?** Salaried pros are paid for online minutes regardless
   of customer payment (correct by design). But there is no
   dashboard/alert/metric in the audited diff that surfaces *how much* unpaid-
   but-serviced volume is accruing. `GetUnpaidBookingsForCustomer` answers it
   per customer on demand; nothing aggregates it for ops. If the pilot intends
   to "accept it as a known cost," confirm the cost is actually logged somewhere
   observable.
5. **Force-complete operational policy.** Force-complete correctly produces
   `completed + unpaid` for the block to fire, but whether admins are trained to
   use it only for genuinely-served-unpaid bookings (vs as a generic "close
   this") is a process assumption, not a code guarantee.
