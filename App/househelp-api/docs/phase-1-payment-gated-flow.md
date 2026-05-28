# Phase 1 — Two-OTP Payment-Gated Service Flow: Risks + Requirements

Living notes for the Phase 1 rollout. Updated as the work progresses; the
implementation lives in `internal/otp`, `internal/booking`, and
`internal/payments`. Phase 1 plan is in the conversation transcript, not
checked in.

## Cash path — customer choice, not pro choice

**Decision (Phase 1 Step 3).** Cash is a CUSTOMER-initiated payment
method, not a pro action. At end of service the customer's TrackLive
screen shows a payment-method choice: CASH (with a "Are you sure?"
confirmation) or ONLINE (Cashfree). One successful resolution closes
the other path:

- Online payment SUCCEEDS → cash option closed (booking is now
  `payment_status='paid'` so the `ResolveCash` handler returns
  `ALREADY_PAID_ONLINE`).
- Cash CONFIRMED → online option closed (the booking carries
  `cash_collected_at`; the customer app hides the pay-online button
  and the Cashfree-order endpoint should not be hit again).
- Online FAILS or is ABANDONED → both options stay open. Cash is the
  fallback.

**Residual-race guard.** When the customer taps "Yes, pay cash",
`ResolveCash` checks for an existing Cashfree order in
`gateway_status='pending'` for the booking **created within the
last 2 minutes**. If one exists, the cash confirmation is rejected
with `ONLINE_PAYMENT_PENDING` ("An online payment is processing,
please wait.").

The freshness bound is critical for the "cash works if online fails"
rule. When the customer abandons the Cashfree drop-in, Cashfree fires
`PAYMENT_USER_DROPPED_WEBHOOK` and the payment row flips to `'failed'`
— typically within ~30 seconds, but a slow UPI flow can take longer.
Without a freshness bound a stuck `'pending'` row would trap a
customer who tried online, gave up, and now wants cash. With the
2-minute bound: any `'pending'` row older than the customer's most
recent attempt is treated as abandoned and falls through to cash. The earlier symmetric guard at Cashfree
order creation + webhook-side conflict detection + auto-refund machinery
were considered and rejected as overkill for the pilot — the single
pending-order check at the cash entry point closes the only meaningful
window.

**Attribution.** When the customer confirms cash, the assigned helper's
id is snapshot into `bookings.cash_collected_by_pro` at that moment.
This is a defensive snapshot — if any future code path ever rewrites
`bookings.helper_id` (e.g. a reschedule-with-reassignment flow), the
owed-money ledger stays correctly attributed to the pro who physically
took the cash.

**Tradeoff — accepted for pilot.** Tapping "Yes, pay cash" issues the
End OTP with no in-app proof that the pro physically received the
money. Enforcement is operational, not technical:

- Booking is attributed to the assigned pro and counts in their owes
  total.
- Settlement happens in person, end of day, via the CRM "Mark settled"
  flow in `internal/crm/cash`.
- Pro is salaried (no per-job incentive to inflate or skip).
- Small society / contained pilot population means the company knows
  who every pro is.

At scale this becomes a real audit gap and the model needs a different
proof (e.g. pro confirms receipt in their app, customer + pro both
acknowledge, signed digital receipt). Not now.

## CRM cash UI (Step 3.B)

The `internal/crm/cash` package exposes:

- `GET  /crm-api/cash/owes` — list every pro with unsettled cash
- `GET  /crm-api/cash/owes/:proID` — per-collection detail for one pro
- `POST /crm-api/cash/owes/:proID/settle` — batch settle (admin only,
  audited)

The React screens for these endpoints in `App/zopmop-crm/` are Step
3.B in the Phase 1 plan — explicitly scheduled, not indefinitely
deferred. Until 3.B lands, the founder hits the endpoints directly
each evening for reconciliation.

## Deployment coupling — MANDATORY merge order

The Phase 1 backend (Steps 0-3) turns `POST /bookings/:id/start` and
`POST /bookings/:id/complete` into hard OTP gates (Step 1). The
`/pro/jobs/:id/start|complete` aliases share the same handler.

Any pro-app build that pre-dates Step 4 sends NO request body to those
endpoints. Under the Phase 1 backend it gets `400 OTP_REQUIRED`. **A
booking in flight when the backend ships strands its pro** — they
cannot start, cannot complete, and the toast is unactionable.

**Required merge order**, no exceptions:

1. Ship the new pro app (Step 4 + Step 5 of Phase 1) to **every** pro
   first. Force-update the app on launch so older builds cannot
   reach the production backend after the gate flips. App-store
   release windows + a `min_app_version` server-side check
   (already-existing pattern in this app) gate the cutover.

2. **Only then** merge `feature/otp-namespace-separation` (backend
   Steps 0-3) → `develop` → `main`. Railway picks up `main`.

3. Verify zero in-flight bookings on the old pro-app build (or treat
   the small residual cohort as known acceptable churn, with support
   manually unblocking via the existing CRM mark-complete escape).

Reverse order = silent regression for any pro who hasn't updated
their app. Do NOT merge the backend ahead of the pro release.

The customer-app changes (Step 5) have the same property to a lesser
degree: an OLD customer build won't render the Start OTP / End OTP /
payment-choice surface, so the customer can't complete their side of
the flow. Same cutover discipline applies — pro AND customer apps
ship first, backend merges last.

## Known, accepted risks (pilot)

### 1. Matched-but-never-paid pro time

**Risk.** Under the new flow the customer's Cashfree payment is moved from
checkout (before-matching) to during in_progress (mid-service). As a result
the matching engine and the scheduled dispatcher now admit Cashfree
bookings with `payment_status = NULL` — see the widened predicates in
`internal/matching/engine.go:FetchPendingUnmatched`,
`internal/matching/scheduled_dispatch.go`, and the two customer-list
queries in `internal/booking/repository.go`.

That means a pro can be dispatched, accept, travel, and arrive at a
customer who never opens TrackLive and never pays. The pro burns time on a
job that ultimately falls into the admin force-complete escape hatch and
lands in the completed-and-unpaid block state.

**Why we accept it for pilot.**

- Pro payroll (`internal/payroll/calc.go`) is salaried on online/working
  minutes — the pro is compensated for the time regardless of whether the
  customer pays. This is a company-cost concern, not a pro-fairness one.
- The End-OTP + payment gate in `(*booking.Service).CompleteBooking`
  blocks the booking from reaching `completed + paid` without payment
  actually landing, so the worst-case state is `completed + unpaid`,
  which the existing `GetUnpaidBookingsForCustomer` predicate already
  uses to block the customer's next booking.
- At pilot volume, the company-cost-per-no-pay event is small and a
  known cost of the new flow.

**Mitigations available at scale (do NOT build now).**

- Pre-authorisation hold on the customer's Cashfree saved method before
  dispatch, captured only after End-OTP fires. Requires a Cashfree
  product the current Drop Checkout SDK does not expose; would also
  bring back most of the old "pay-before-service" friction. Not worth
  it for pilot.
- Aggregate metric: pro hours spent on completed-and-unpaid jobs / total
  pro hours. If this number climbs above ~5% in a steady-state week,
  re-evaluate. Not instrumented at pilot.

**Status.** Accepted for pilot. Revisit when scaling beyond initial
geography. Not actioned.

## Frontend requirements (Steps 4 & 5)

These are backend-derivable but UI-binding. Recorded here so a
fresh-context implementer of the customer / pro apps doesn't miss them.

### 1. Customer mental model: "you pay when the service is done"

**What changed.** In the old flow the customer paid up front at checkout,
so the booking confirmation screen could honestly say "Paid". Under the
new flow no money has changed hands when the booking is created — the
pro is dispatched, arrives, the customer reads the Start OTP, the
service happens, and only THEN does the customer tap the pay button on
TrackLive (Cashfree) or pay the pro in cash.

**Where this surfaces in the UI.**

- **Booking confirmation screen** (post-create, before pro is matched):
  must clearly communicate "You'll pay when the service is done."
  Existing "Payment: Paid" / "Total to pay" copy is incorrect under the
  new model; replace with "Pay after service" or equivalent. Without
  this, customers who paid up-front for years will be confused when a
  pro arrives and no transaction has happened.
- **TrackLive** (during pro travel / service): clear "Pay when ready"
  affordance once `payment_status` is still pending. The button is the
  centerpiece of the screen during in_progress.
- **Bookings list ("upcoming" tab)**: a row in `accepted` /
  `in_progress` with `payment_status = NULL` is legitimate state — do
  not render a "Payment failed" or "Action required" warning on it.
  The TrackLive screen handles the payment prompt.

**Backend supports this already.** The booking row carries the full
state — frontend just needs to render it correctly. No backend change
needed.

### Service OTP rate limit — per booking, per scope

`otp.Verify` enforces **10 wrong attempts per 5 minutes** for each
`(scope, ownerID)` pair, keyed in Redis under
`otp:verify-attempts:{scope}:{bookingID}`. The 11th attempt returns
`ErrTooManyAttempts` (mapped to `429 OTP_TOO_MANY_ATTEMPTS` by the
booking handler) WITHOUT consulting the stored code or the
constant-time compare path.

The counter is keyed by `(scope, ownerID)` so:

- A pro juggling **two bookings** has independent budgets — a fail-run
  on booking-1 cannot pre-lock booking-2's gate.
- The **Start** and **End** OTPs of the same booking have independent
  budgets — fumbling Start digits doesn't pre-lock End.
- A successful match **clears the counter** so legitimate fumbling on
  Start doesn't carry stale fail credit into End.

The lockout self-heals after the 5-minute window expires (counter TTL
runs down → next INCR starts at 1).

**Pro-app message contract.** The 429 message is intentionally
time-honest:

> "Too many wrong attempts. Wait a moment, then try again."

The message MUST NOT suggest reloading TrackLive as a fix. Reloading
does NOT re-issue the OTP: `(*Service).GetTracking` calls `otp.Peek`,
which returns the existing code — a reload surfaces the same code
that the pro just locked out attempts against. The only legitimate
unblocks are TIME (the 5-min window) or operational SUPPORT (State E
contact). The State E support link must be made prominently
available when the pro is locked out.

### Service OTP issuance — Peek-then-Issue discipline

`otp.Service.Issue` is an unconditional Redis `SET` — every call mints
a fresh code and overwrites any prior one. This is correct at the
genuine issuance points (`MarkEnRoute`, `CashfreeWebhook` success,
first cash resolution): a fresh code is the point.

It is **wrong** at idempotent / self-heal entry points (a second
`ResolveCash` tap, a TrackLive load when an OTP already exists). A
fresh code there would desync a customer mid-handoff: they read code
`X` to the pro, server mints `Y`, gate now rejects `X`.

The contract for any self-heal / idempotent issuance point is
**Peek-then-Issue**:

```text
existing, err := otp.Peek(scope, ownerID)
if errors.Is(err, otp.ErrNotFound):
    otp.Issue(scope, ownerID)   # no code outstanding — self-heal
else:
    # code IS outstanding — leave it. Customer already has it.
```

Locked into `(*booking.Service).ResolveCash` for the idempotent
repeat-tap path. **Same pattern is required by the Step 5 TrackLive
self-heal** — implementers must use Peek-then-Issue there too, not
unconditional Issue.

### 2. End-OTP self-heal on TrackLive load (Step 5 sub-requirement)

**The problem.** `CashfreeWebhook` issues the End OTP post-commit
(`internal/payments/handler.go`), and the cash-mark path (Step 3) does
the same. Both are best-effort — Redis hiccups or process restarts
between the SQL commit and the OTP issuance can leave a booking in
`payment_status = 'paid'` with NO outstanding End OTP. The pro cannot
complete the booking; the customer cannot share a code that does not
exist.

**Self-heal contract for TrackLive (`GET /bookings/:id/tracking`).**

On every load, before returning the response payload, the handler MUST:

```text
IF booking.status = 'in_progress'
  AND (booking.payment_status = 'paid' OR booking.cash_collected_at IS NOT NULL)
  AND otp.Peek(ScopeEnd, bookingID) returns ErrNotFound
THEN
  call otp.Issue(ScopeEnd, bookingID)
  Peek again to populate response.EndOTPCode
```

Same idempotent guarantee applies: `Issue` overwrites any prior code, so
a race where two TrackLive loads both reach the check is safe — the
later Issue wins, the customer sees the latest code, and the pro types
that one. The earlier code becomes unverifiable; not a leak.

The same pattern should also cover Start OTP: if `en_route_at IS NOT
NULL` and `Peek(ScopeStart, bookingID) == ErrNotFound`, re-issue. This
covers a `MarkEnRoute` Redis failure (the post-commit issuance in
`(*Service).MarkEnRoute` is non-fatal — see Step 2).

**Status.** Not yet implemented. To be implemented in Step 5 (Customer
TrackLive + home pill).

### 3. Home pill — derive "live" from existing booking-list payload

The home-screen "live booking" pill must NOT have a new dedicated
backend endpoint. Customer apps already read `en_route_at`, `arrived_at`
and `status` from the existing GET `/bookings?status=upcoming` payload.
Filter client-side:

```text
livePillVisible = upcomingBookings.any(b =>
  b.en_route_at != null AND b.status IN ('accepted', 'in_progress')
)
```

Pill appears the moment the pro taps "On my way" (which stamps
`en_route_at` AND issues the Start OTP — see Step 2). Tapping the pill
opens TrackLive for that booking.

The pill is HOME SCREEN only — not the app-wide tab bar. Same behavior
for instant and scheduled bookings.
