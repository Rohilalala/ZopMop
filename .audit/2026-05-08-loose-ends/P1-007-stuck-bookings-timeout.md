P1-007 - pending_customer_action bookings have no auto-timeout (scheduled stealth only)

Severity: P1
Category: CORR
Surfaced by: System walkthrough Part 6 + code audit 2026-05-08
Date: 2026-05-08

SUMMARY
ZopMop has two booking flows with different timeout behaviors. Instant
bookings (7am-8pm) already auto-cancel with refund after a 2-minute search
window if no helper accepts - this path is implemented and working.
Scheduled stealth bookings (booked after 8pm for the next 1-2 days, served
during 7am-8pm) use a 15-minute search window before flipping status to
pending_customer_action and pushing the customer a "Keep Looking or Cancel"
prompt. If the customer ignores both options (closes app, miss push, etc),
the scheduled booking sits in pending_customer_action indefinitely - slot
held, payment held, no system action ever reclaims the row. Fix: build a
sweeper that auto-cancels pending_customer_action rows older than 30 min,
releases slot, refunds wallet, queues Cashfree refund, sends final
notification. Approx 4 hr.

LAUNCH-READINESS CONTEXT
Confirmed business logic and feature scope for launch as of 2026-05-08:

Booking flow split:
- Instant booking (7am-8pm only): 2-min search window. Auto-cancels with
  cancelled_by='no_pros_found' if no match. Payment: COD upfront, or
  Cashfree upfront with auto-refund on no-match. Already implemented at
  internal/booking/service.go:1392 and internal/matching/dispatch.go:464.
  This flow does NOT use pending_customer_action.
- Scheduled stealth (after-8pm bookings for next 1-2 days, served
  7am-8pm): 15-min search window starting at fire_at = scheduled_time -
  15 min. After window expires without an accept, status flips to
  pending_customer_action. Customer gets push with Keep Looking / Cancel
  options. This flow DOES use pending_customer_action.

Other launch facts:
- Roomies / household groups: ACTIVE at launch (re-classify INDEX row 028
  from P3 to P1 - worker responsibilities need verification before launch)
- Zop AI assistant: ACTIVE at launch. Backend at internal/zop/, mobile
  ZopChat component. Routes /zop/* gated to customer role (commit
  1eb6c98). 12 customer-only tools, 200 req/hour rate limit
- Wallet + Cashfree code: SHIPPING and ACTIVE. Cashfree merchant KYC
  complete. Production wiring verification per P1-008
- Helper payouts: fixed monthly salary via external payroll. crm_payouts
  module dormant (P1-006 reclassified P3)

This ticket only addresses scheduled stealth bookings stuck in
pending_customer_action. Instant bookings are out of scope - their
auto-cancel-on-timeout is already correct.

FINDING
Scheduled stealth dispatch flow as it works today:

1. Customer creates booking after 8pm IST for a service slot in next 1-2
   days during 7am-8pm
2. Backend classifyScheduling sets fire_at = scheduled_time - 15min,
   isStealth=true, status='pending'
3. StealthDispatcher (60s tick) claims the booking when fire_at <= now()
4. InviteChain runs against helper pool; status flips to 'searching'
5. After stealthSearchWindow (15 min from fire_at) elapses with no
   acceptance: stealth_dispatch.go:166 transitions status to
   'pending_customer_action'
6. Customer receives "still looking" push (pushStillLooking in
   stealth_dispatch.go:177)
7. Customer is expected to tap Keep Looking (POST
   /bookings/:id/keep-looking - extends 15 min) or Cancel (POST
   /bookings/:id/cancel - refunds and releases slot)

The gap: step 7 has no deadline. If the customer never taps either
option (push notifications disabled, app closed, ignored push, app
crashed before push arrived), the booking sits in pending_customer_action
indefinitely. Time slot capacity stays decremented. Payment stays held
(wallet debited or Cashfree-charged). No helper is searching. No system
sweeper exists to reclaim these rows.

EVIDENCE FROM 2026-05-08 CODE AUDIT
grep "pending_customer_action" returns:
- migrations/054_booking_scheduling_meta.up.sql lines 57, 71 (status enum)
- internal/matching/stealth_dispatch.go lines 12, 161, 166 (the status set)
- internal/booking/handler.go lines 322, 338 (the keep-looking handler)
- internal/booking/service.go lines 917, 943-944 (KeepLookingBooking
  guard - only valid when status='pending_customer_action' AND isStealth)

stealthSearchWindow = 15 * time.Minute defined at
internal/matching/dispatch.go:50.

Instant booking 2-min auto-cancel exists at internal/booking/service.go:1392
(time.Since(createdAt) > 120*time.Second) and dispatch.go:464
(cancelled_by='no_pros_found'). Confirms instant flow is already correctly
auto-cancelled and refunded - this ticket does not need to address it.

No grep result for any sweeper or worker that handles
pending_customer_action time-out. Confirms the gap.

REPRODUCTION
1. After 8pm IST, create a stealth booking via mobile app for a slot in
   the next 1-2 days during 7am-8pm
2. Wait for fire_at to elapse (or manually advance fire_at to now())
3. Wait 15 minutes - StealthDispatcher will eventually flip booking to
   pending_customer_action
4. Verify booking row state in DB:
   SELECT id, status, fire_at, created_at, updated_at FROM bookings
   WHERE status='pending_customer_action';
5. Wait 60 minutes more, do not tap Keep Looking or Cancel from the app
6. Verify the booking row is unchanged - same status, same updated_at
7. Verify time_slots.current_bookings is still incremented for that slot
8. Verify wallet (if wallet-paid) shows no refund

BLAST RADIUS
At launch with low volume:
- Slot capacity false-saturation: a single dead booking holds a 7am-8pm
  slot, blocking legitimate new bookings into that slot
- Customer support: "I'm charged for a booking but no one came in the
  morning"
- DB grows monotonically with stuck rows

At higher volume:
- Compounds. 50 dead pending_customer_action rows means 50 dead 7am-8pm
  slot reservations across the next 1-2 days
- Real customers see "no slots available" on slots that should be open
- Audit and incident response harder because dead rows pollute searches

All three payment paths at launch (cash, wallet, Cashfree) require
correct refund handling in the sweeper:
- Cash payment: no money to refund, just release slot + notify customer
- Wallet payment: credit wallet, log wallet_transactions row, emit outbox
- Cashfree payment: queue pending_refunds row for existing refund worker

FIX PLAN

New sweeper goroutine: PendingActionSweeper
File: internal/booking/pending_action_sweeper.go
Started in cmd/api/main.go alongside StealthDispatcher, RebookScanner, etc.

Tick interval: 5 minutes (matches RebookScanner cadence, low overhead)

Per tick:
1. SELECT id, customer_id, helper_id, time_slot_id, payment_method,
          payment_status, amount_paise
   FROM bookings
   WHERE status='pending_customer_action'
     AND updated_at < NOW() - INTERVAL '30 minutes'
   FOR UPDATE SKIP LOCKED
   LIMIT 50

2. For each row, in a single pgx transaction:
   a. UPDATE bookings SET status='cancelled',
        cancelled_at=NOW(),
        cancelled_by='auto_timeout_no_action'
   b. Release time slot:
        UPDATE time_slots
        SET current_bookings = current_bookings - 1
        WHERE id = $time_slot_id AND current_bookings > 0
   c. If payment_method='wallet' AND payment_status='paid':
      wallet.CreditTx(customer_id, amount_paise, 'refund_credit',
        booking_id,
        idempotency_key='auto_cancel_'||booking_id)
      Insert event_outbox row (booking.auto_cancelled)
   d. If payment_method='cashfree' AND payment_status='paid':
      Insert pending_refunds row (status='pending',
        reason='auto_cancel_no_action')
      The pending_refunds row is consumed by existing Cashfree refund
      worker - active at launch. Verify worker is wired and processing.
   e. If payment_method='cash' or unpaid: no money movement
   f. Insert FCM notification queue entry: customer push "Your booking
      could not be assigned and was automatically cancelled. Any payment
      will be refunded within 5-7 days."

3. After tx commits: trigger FCM dispatch via existing notification path

Idempotency:
- WHERE status='pending_customer_action' filter is naturally idempotent -
  once status flips to cancelled, row no longer matches
- Wallet refund uses CreditTx idempotency_key derived from booking_id
- Cashfree pending_refunds uses booking_id as natural key (verify schema
  enforces uniqueness)

Threshold tuning:
- 30 min default after pending_customer_action set
- Could be 15 min (tighter, less waiting) or 60 min (more chance for
  customer to respond)
- Make it a config knob: PENDING_ACTION_TIMEOUT_MINUTES (default 30)

Observability:
- Log INFO line per swept booking: booking_id, age, payment_method, action
- Counter metric: bookings_auto_timed_out_total
- Alert if more than N timeouts per hour (signals matching engine
  breakage upstream)

Testing:
- Unit: time-based threshold logic, threshold respected
- Integration: insert fake pending_customer_action row backdated 31 min,
  run sweeper, verify status flip + slot release + wallet credit
- Concurrency: two sweeper instances against same row (SKIP LOCKED test)
- Cashfree branch: verify pending_refunds row created
- Customer notification: verify FCM payload sent

RECOMMENDATION
Implement the sweeper before any production launch traffic. Default
threshold 30 min. Add the config knob. Wire observability from day one.

All three payment branches must be tested before launch:
- Cash: status flip + slot release + customer push, no money movement
- Wallet: status flip + slot release + wallet credit + outbox + customer push
- Cashfree: status flip + slot release + pending_refunds row + customer push

EFFORT
- Sweeper implementation + config knob: 2 hr
- Tests (unit + integration + concurrency): 1.5 hr
- Wire into main.go alongside existing background workers: 15 min
- Manual end-to-end verification across 3 payment branches: 30 min

Total: approx 4 hr

DEPENDENCIES
- P0-001 (event_outbox consumer) is independent but the sweeper writes
  outbox rows for the wallet branch - those rows accumulate with no
  consumer until P0-001 ships. P0-001 first ideally, but P1-007 can
  ship first with the understanding that outbox events stay 'pending'
  until consumer lands

ACCEPTANCE CRITERIA
- pending_customer_action booking older than 30 min auto-cancels within
  one tick (5 min)
- Time slot capacity is restored on auto-cancel
- Wallet-paid bookings receive auto-refund credit with idempotent key
- Cashfree-paid bookings get pending_refunds row queued for existing
  refund worker
- Cash bookings (no payment held) cancel cleanly, slot released,
  customer notified
- Customer receives FCM notification of auto-cancellation
- Sweeper survives multi-instance deploy (SKIP LOCKED prevents
  double-cancellation)
- Metric: bookings_auto_timed_out_total visible in observability surface
- Instant bookings are NOT touched by this sweeper (their 2-min
  auto-cancel is already correct)

ANCHOR
Pre-fix tag: pre-fix-pending-action-sweeper

INDEX UPDATE NEEDED ALONGSIDE THIS TICKET
Row 028 (Roomies worker responsibilities unclear) should escalate from P3
to P1 per business logic confirmed 2026-05-08 (roomies active at launch).
Not blocking but worth doing in same INDEX patch session.
