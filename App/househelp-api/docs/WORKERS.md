# In-process workers — multi-instance safety plan

The api process currently runs nine in-process background workers as
goroutines. None of them are leader-elected. A single Railway replica
is fine today; the first autoscale event will double-fire every cron
and race the matching engine.

This document captures the workers, the failure mode, and the path
forward. Filed against `audit/findings/devops.md` and
`audit/findings/performance.md`.

---

## Current in-process workers

Started from `cmd/api/main.go` after the Fiber app starts:

| Worker | Source | Cadence | Effect of double-fire |
|---|---|---|---|
| ScheduledDispatcher | `internal/matching/dispatch.go` | ~1 min poll for due scheduled bookings | Two invites sent to the same pro for the same booking |
| StealthDispatcher | `internal/matching/stealth_dispatch.go` | event-driven (post-create) | Same booking transitioned to `searching` twice; Redis race |
| RebookScanner | `internal/matching/rebook.go` | periodic | Duplicate rebook invitations |
| MatchBatcher | `internal/matching/batcher.go` | periodic flush | Duplicate FCM pushes |
| Outbox sender | `internal/outbox` | periodic poll | Duplicate webhook deliveries (idempotency on receiver helps but not guaranteed) |
| Leave monthly-reset cron | `internal/leave` | hourly check, fires on month boundary | Double-credit of leave entitlement |
| Roomies auto-settle cron | `internal/roomies` | hourly | Double-settlement; wallet ledger corruption |
| Reengagement scanner | `internal/reengagement` | periodic | Duplicate reactivation notifications |
| Rollup / segment workers | `internal/insights`, `internal/segments` | periodic | Duplicate aggregate rows |

The 25 s per-pro accept window inside InviteChain is in-process
state; a second replica's InviteChain doesn't see the first replica's
timer, so two parallel invites can both fire and both wait for an
accept.

---

## Failure mode summary

- **Wallet / money:** double-settle is the worst case. Roomies
  auto-settle + leave monthly-reset are the highest-risk workers.
- **External effects:** outbox double-send + FCM double-push are
  annoying for users but recoverable (FCM dedup on the device side,
  webhook receivers should idempotency-key).
- **Matching:** double-invite is a UX bug and wastes a pro's accept
  window slot, but is recoverable (only the first accept wins via
  the `AcceptBooking` CAS at `internal/booking/repository.go:359-369`).

There are no known data-corruption paths on a 2-replica run **today**
because of the booking-accept CAS and the wallet ledger UNIQUE
constraints. But this is luck — once any of the above workers gains
a new path that writes without a UNIQUE constraint, the next
autoscale event corrupts data.

---

## Path forward (two options, pick one)

### Option A — Extract workers to a single-replica `worker` binary

The cleanest fix. The api becomes purely request-handling and runs
behind any replica count. A second Railway service named `worker`
runs the cron + outbox loops with `replicas: 1` enforced.

Steps:
1. Add `cmd/worker/main.go` that imports the same modules and
   starts the cron loops only.
2. Update the Dockerfile to build both binaries (already builds
   `api` + `migrate`).
3. In `cmd/api/main.go`, gate the cron starts behind
   `os.Getenv("RUN_WORKERS") == "true"` so a single binary can
   still run as both api and worker in dev.
4. Provision a new Railway service `worker` from the same repo
   with a custom start command `/usr/local/bin/worker`. Set
   `replicas: 1` and disable autoscale.
5. Disable cron start in the api service (default to false).
6. Smoke test: confirm worker logs show cron firing; confirm api
   logs do NOT.

Effort: ~1.5 days including the Railway service setup.

### Option B — Redis-based leader election in-process

Cheaper to implement, harder to reason about. Each cron loop, on
each tick, attempts to acquire a Redis `SET NX` lock with a TTL just
longer than the work duration. Only the lock holder runs.

Steps:
1. Add `pkg/leader/lease.go` exposing `WithLease(ctx, key, ttl,
   func)`.
2. Wrap each cron tick: `leader.WithLease(ctx, "lease:scheduled_dispatch", 90s, func() { runOnce() })`.
3. Ensure the lease TTL exceeds the longest possible task run
   time, with margin for clock skew.
4. Document the failure mode: if the lock holder crashes mid-task,
   the next tick (TTL later) takes over. Some tasks may run twice
   if the crash happens after the side effect but before the
   `DEL`.

Effort: ~half a day. Trade-off: every long-running cron tick must
periodically extend the lease (`PEXPIRE`), and a missed extension
during a GC pause causes a duplicate run.

---

## Recommendation

**Option A.** Extracts the operational separation cleanly; lets the
api scale freely; matches the standard 12-factor split. Cost is one
extra Railway service ($5-10/month).

Option B is acceptable if Option A is rejected for cost reasons, but
the leader-election bugs are the kind that surface during incidents
when no-one wants to debug them.

---

## Stop-gap until either option ships

Keep the Railway service at exactly **1 replica**. The audit's
performance subagent recommends explicit autoscale-disabled until
the extraction is done. Set:

- Railway dashboard → ZopMop → Settings → Scale → set min/max
  replicas to 1.

If you anticipate a load spike (launch day, marketing push),
**vertically** scale (CPU/RAM) the single replica instead of
horizontally. Bigger replica fine; second replica bad.

---

## Open questions before implementation

- Q15 / Q16 / Q19 in `audit/OPEN_QUESTIONS.md` need answers first.
  Specifically: replica count target, Railway Postgres connection cap.

- Should `MatchBatcher` and `InviteChain` move with the workers, or
  do they stay in the api process and rely on the booking-accept
  CAS to deduplicate (current behavior)? They are tightly coupled
  to per-request state.
