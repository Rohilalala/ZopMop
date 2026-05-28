# Phase 1 — Two-OTP Payment-Gated Service Flow: Risks + Requirements

Living notes for the Phase 1 rollout. Updated as the work progresses; the
implementation lives in `internal/otp`, `internal/booking`, and
`internal/payments`. Phase 1 plan is in the conversation transcript, not
checked in.

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
