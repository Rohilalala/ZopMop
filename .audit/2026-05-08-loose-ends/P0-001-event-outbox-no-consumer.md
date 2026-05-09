# P0-001 — event_outbox has writers but no consumer

**Severity:** P0
**Category:** DATA
**Surfaced by:** System walkthrough Part 6
**Date:** 2026-05-08

## Summary

The transactional outbox pattern is half-implemented: writes happen atomically
with business logic, but no goroutine drains the table. Rows accumulate
forever as `status='pending'`, silently breaking any feature that depends on
event-driven side-effects (segment recompute, downstream pushes, future
webhooks). Fix: build a 5-second polling consumer in `cmd/api` next to the
existing background workers. ~4-6 hr.

## Finding

The `event_outbox` table is written transactionally by wallet credits, wallet
debits, booking-paid flows, and wallet topups. The writes use the standard
transactional outbox pattern — INSERT into `event_outbox` happens in the same
pgx transaction as the business logic, ensuring atomicity.

But there is no consumer goroutine, worker, or external service draining the
table. Rows accumulate with `status='pending'` indefinitely. Any downstream
side-effect that depended on these events (analytics, segment updates, future
external webhooks, audit pipelines) silently never fires.

This is a half-implemented pattern: the writer side is shipped, the consumer
side was deferred or forgotten.

## Evidence

Migration that created the table:
```
migrations/069_event_outbox.up.sql (approximate — verify exact migration number)
```

Producers (writes that emit outbox rows):
```
internal/wallet/wallet.go         — CreditTx, DebitTx
internal/payments/cashfree.go     — webhook PAYMENT_SUCCESS path
internal/booking/service.go       — paid-state transitions
```

Search for consumer:
```bash
grep -rn "event_outbox" --include="*.go" -r .
grep -rn "OutboxWorker\|outbox.Process\|DrainOutbox" --include="*.go" -r .
```

Expected: no results from the second grep. Confirm.

## Blast Radius

- **Severity escalates with time.** A small backlog at launch (50 events) is
  fine. A 6-month-old backlog (500K events) blocks any future consumer from
  starting cleanly.
- **Silent feature gap.** Anything you build that listens to outbox events
  won't work until you also build the drainer.
- **Specifically broken at launch:**
  - User segments (NEW/RETURNING/AT_RISK/CHURNED) — segments worker exists
    but if it relies on outbox events, segment computation is wrong.
  - Wallet top-up confirmation push — if push delivery hangs off
    `wallet.topped_up` event, users don't get confirmation pushes.
  - Booking-paid analytics — revenue analytics that count from outbox events
    will be undercounted.
- **Not directly user-visible** — users still see their wallet balance change,
  bookings still confirm, etc. The bug is operational/analytical.

## Reproduction

```sql
-- Connect to Railway PostGIS
SELECT status, COUNT(*) FROM event_outbox GROUP BY status;
-- Expected: pending count grows monotonically over time
```

```sql
-- Look at events that should have been processed
SELECT event_type, COUNT(*), MAX(created_at) - MIN(created_at) AS span
FROM event_outbox
WHERE status='pending'
GROUP BY event_type;
```

If `pending` count is non-zero AND no `processing` or `done` rows ever exist,
the consumer is missing.

## Fix Plan

### Option A: Build a polling consumer (recommended for ZopMop scale)

A simple polling worker is sufficient. ZopMop's event volume at launch is
< 100/min; a polling architecture is correct here, no need for Postgres LISTEN/
NOTIFY or external broker.

Architecture:
- New file: `internal/outbox/worker.go`
- Goroutine ticker: 5-second intervals
- Per tick:
  1. `BEGIN; SELECT * FROM event_outbox WHERE status='pending' AND
     available_at <= NOW() ORDER BY created_at LIMIT 100 FOR UPDATE SKIP
     LOCKED; COMMIT;` — atomic claim with skip-locked for multi-instance
     safety.
  2. For each claimed row: dispatch to handler registered by event_type.
  3. On success: `UPDATE event_outbox SET status='done', processed_at=NOW()`
  4. On handler error: `UPDATE event_outbox SET status='failed',
     attempt_count=attempt_count+1, last_error=$1, available_at=NOW() +
     INTERVAL '<exponential backoff>'`. Cap retries at 10; after that,
     `status='failed_terminal'` requires manual intervention.

Handler registry (where to start):
- `wallet.credited` → no current downstream, register a no-op handler that
  logs and marks done. Future: emit to analytics SDK once SDK is wired.
- `wallet.debited` → same.
- `wallet.topped_up` → FCM push to user "₹X added to wallet."
- `booking.paid` → FCM push to customer if not already sent through direct
  Cashfree webhook flow; segment recompute trigger.

### Option B: Outsource to a worker service

Run a separate `cmd/outbox-worker` binary on Railway. Same logic as Option A
but isolated process. Useful at higher scale (1000+ events/min) but overkill
for launch.

### Option C: Postgres LISTEN/NOTIFY

Trigger on insert to `event_outbox` notifies a goroutine. Lower latency than
polling. More complex error semantics. Not recommended for ZopMop today.

## Recommendation

**Option A.** 5-second polling consumer in the same `cmd/api` binary, started
as a goroutine in `main.go` next to the existing background workers
(ScheduledDispatcher, StealthDispatcher, etc.).

## Effort

- Architecture decision + handler registry design: 30 min
- Implementation: 2 hr
- Tests (golden path, retry path, multi-instance contention): 1.5 hr
- Deploy + verify in production: 30 min

**Total: 4-6 hours.**

## Dependencies

- Decide which existing events have meaningful downstream actions vs which
  are forward-compat-only (no current handler).
- For events with no handler today, document that they're forward-compat in
  a comment in the event-type registry.

## Acceptance Criteria

- `event_outbox.status='pending'` count monotonically declines after deploy
  (events get processed faster than they're created).
- Retry path verified with a deliberately-failing handler test.
- Multi-instance safety verified (run two API replicas, confirm SKIP LOCKED
  prevents double-processing).
- Add a `/health/outbox` endpoint or metric: pending count, oldest pending
  age, failed_terminal count. Alert if oldest pending > 5 min OR
  failed_terminal > 10.

## Anchor

Pre-fix tag: `pre-fix-outbox-consumer`
