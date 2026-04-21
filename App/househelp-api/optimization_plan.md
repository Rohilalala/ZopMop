# Backend Optimization Plan (Toward ~10,000 Concurrent Users)

## Scope and current baseline
- Existing hardening present: JWT rotation, sanitized errors, PgBouncer (transaction mode), initial load campaign.
- Observed baseline degradation from prior tests: p95 grows sharply near ~1000 concurrent active requests; multi-second tail at ~2000+.
- Key bottleneck areas now: analytics aggregation cost, booking query shapes, DB queue behavior, and uneven limiter policy on auth endpoints.

---

## 1. Query Performance Analysis

## 1.1 High-cost query patterns and exact optimization strategy

| Query area | Current pattern | Why it is slow | Optimization strategy |
|---|---|---|---|
| **Funnel (analytics)** | `COUNT(DISTINCT user_id)` grouped by `event_name` over time windows (`analytics_events` fallback path) | Large-window distinct aggregation drives hash/sort work; previously observed seq scan + external sort/temp spill | 1) Keep `analytics_event_user_daily` as primary. 2) Add hourly rollup for recent windows to avoid raw-table distinct. 3) Add BRIN on `analytics_events(created_at)` for append-only pruning. 4) Partition `analytics_events` by month once table size exceeds threshold. |
| **Worker performance (analytics)** | LEFT JOIN `helpers`→`bookings`, aggregate + HAVING + ORDER BY aggregate | Aggregates across many booking rows per helper per request; expensive under concurrent admin traffic | 1) Precompute `analytics_helper_daily` rollup. 2) Query rollup table for dashboard. 3) Add `bookings(helper_id, created_at DESC)` index with included status/timing columns where supported. |
| **Overview/ops/revenue trends (analytics)** | Repeated full-window scans on `bookings` for counts/sums/timings | Multiple endpoints re-scan same fact table; CPU/IO amplification at peak | 1) Precompute booking KPI rollups (`hourly`, `daily`). 2) Endpoint queries read only rollups; **no runtime delta queries on base tables**. Recent data (<1 min) must be served via cache or accepted staleness. 3) Add partial indexes for `status='completed'` + `completed_at` and `created_at,status` where missing. |
| **Customer bookings list** | `ORDER BY COALESCE(scheduled_time, created_at)` + per-row follow-up query for services (`N+1`) | Expression order can bypass plain indexes; N+1 query multiplies DB round trips | 1) Replace with indexed split (scheduled vs legacy) or generated sort column. 2) Add composite indexes: `(customer_id, scheduled_time DESC)` and `(customer_id, created_at DESC)` (partial where needed). 3) Replace N+1 with one join + aggregation (`json_agg`) in a single query. |
| **Admin bookings list/count** | `COUNT(*)` and page queries over joined booking/user/service tables each request | Join-heavy count path is expensive and grows with table size | 1) Count from filtered `bookings` first, then fetch page IDs, then join by IDs. 2) Move to keyset pagination for large pages. 3) Ensure `(status, created_at DESC)` remains primary serving index. |

## 1.2 Seq scan / external sort / temp-file focus
- **Known from prior run:** funnel-style event query showed seq scan + external sort with temp usage.
- **Plan:** hard-disable this path for normal reads by using rollups as primary and keeping raw query only for **offline backfill jobs**; never used in runtime request paths.
- **Validation during implementation phase:** collect `EXPLAIN (ANALYZE, BUFFERS)` for top endpoints and confirm no large temp-file sorts on hot paths.

## 1.3 Index and partition plan (exact)
1. **Analytics events**
   - Add `BRIN(created_at)` for range pruning on append-only scans.
   - Keep btree on `(event_name, created_at DESC)` and `(event_name, user_id, created_at DESC)` for selective paths.
   - Partition `analytics_events` monthly by `created_at` once cardinality justifies it.
2. **Bookings**
   - Add/confirm: `(customer_id, created_at DESC)`, `(status, created_at DESC)`, `(helper_id, created_at DESC)`.
   - Add partial/composite for scheduled list: `(customer_id, scheduled_time DESC)` where `scheduled_time IS NOT NULL`.
   - Add helper metrics support: `(helper_id, created_at DESC)` with status/timestamps for rollup jobs.
3. **Rollup-serving indexes**
   - Rollup tables keyed by `(bucket_start, dimension...)` and `(dimension..., bucket_start DESC)` for fast bounded reads.

---

## 2. Analytics Optimization Strategy (Rollup-first)

## 2.1 Pre-aggregated datasets
1. **Minute granularity** (`analytics_event_minute`)
   - For near-real-time product dashboards (event throughput, drop-off).
   - Columns: `bucket_minute`, `event_name`, `events_count`.
2. **Hour granularity** (`analytics_funnel_hourly`, `analytics_booking_kpi_hourly`)
   - For operational + funnel windows (last 24h/7d).
   - Columns include counts for viewed/started/created/accepted/completed/cancelled and timing aggregates.
3. **Day granularity** (`analytics_helper_daily`, `analytics_revenue_daily`, existing `analytics_event_user_daily`)
   - For trend views and stable admin analytics.

## 2.2 Storage schema shape
- Fact rollups use immutable/upsert buckets:
  - `bucket_start TIMESTAMPTZ/DATE`
  - dimensions (`event_name`, `helper_id`, etc.)
  - numeric aggregates (`count`, `sum`, `avg_numerator`, `avg_denominator`)
- Primary key per bucket+dimension to allow idempotent upsert.

## 2.3 Refresh strategy
- **Primary:** async worker every minute with watermark checkpoints (no trigger-based heavy logic on request path).
- **Backfill:** periodic batch job (hourly/day) for delayed writes and correction.
- **Read strategy (updated and safe):**
  - Endpoints must query rollup tables as the primary and default source.
  - No direct fallback to base tables under any condition during runtime.
  - If rollup freshness is slightly delayed (e.g., < 2-5 minutes), serve stale-but-safe data instead of querying raw tables.
- **Recent data handling (safe approach):**
  - Maintain a small in-memory or Redis cache layer for ultra-recent (<1 minute) updates if needed.
  - Or accept bounded staleness and avoid real-time merging entirely.
- **Backpressure and safety guarantees:**
  - Rollup worker must maintain bounded queue size, retry with exponential backoff, and watermark checkpointing.
  - If worker lag exceeds threshold, do not switch to raw queries; trigger alerts instead.
- **Guarantee:** at no point should high-traffic endpoints execute large aggregations on base tables.

## 2.4 Guarantee
- No runtime heavy aggregation on large base tables for admin analytics endpoints.

---

## 3. PgBouncer Tuning Plan

## 3.1 Current vs target
- Current compose: `pool_mode=transaction`, `max_client_conn=1000`, `default_pool_size=40`, `reserve_pool_size=10`, `server_idle_timeout=600`, `query_wait_timeout=120`.
- Target tuning (single DB, current hardware):
  - `pool_mode = transaction` (keep; best fit for stateless request queries)
  - `max_client_conn = 2000`
  - `default_pool_size = 50`
  - `reserve_pool_size = 20`
  - `server_idle_timeout = 60`
  - `query_wait_timeout = 8`

## 3.2 Why transaction pooling stays
- Request lifecycle is short and stateless; session features are not required on hot paths.
- Enables many client connections while capping active server connections.
- Reduces PostgreSQL memory pressure and connect churn.

## 3.3 Queue behavior under load
- Expected: clients beyond `default_pool_size + reserve_pool_size` queue briefly in PgBouncer.
- Target behavior:
  - short bounded queue wait in bursts
  - fast fail if saturation persists (`query_wait_timeout`), not hidden 120s tail latency
- Monitoring target:
  - `waiting_clients` sustained > 0 is warning
  - high sustained queue waits trigger backpressure/rate adjustments

---

## 4. Application DB Pool Tuning

## 4.1 Target app pool values
- **MaxOpenConns equivalent (pgx `MaxConns`)**: `80`
- **MaxIdleConns equivalent (pgx warm/idle target via `MinConns`)**: `20`
- **ConnMaxLifetime**: `20m`
- **ConnMaxIdleTime**: `5m`

## 4.2 Interaction with PgBouncer
- App pool should be high enough to keep CPU busy but below levels that create excessive PgBouncer queue pressure.
- PgBouncer remains the hard governor to PostgreSQL server connections.
- Lifetime rotation avoids long-lived stale sockets and synchronized reconnect storms.

## 4.3 Over/under-utilization controls
- If `waiting_clients` grows while DB CPU is low: increase `default_pool_size` slightly.
- If DB CPU saturates and p95 rises: lower app `MaxConns` or tighten request concurrency.

## 4.4 Request Concurrency Control (critical addition)

### 4.4.1 Problem
- Even with PgBouncer, unbounded request concurrency can overwhelm DB CPU, PgBouncer queues, and application threads.
- Current plan controls connections, but not in-flight request volume.

### 4.4.2 Solution
- Introduce a global request-level concurrency limiter (middleware/semaphore) in the application layer.
- Cap DB-bound in-flight requests to a configurable limit (initial: 600, range: 500-800).
- Requests exceeding limit are either queued briefly (bounded) or rejected with `503 Service Unavailable`.
- Queue must be bounded with strict timeout (e.g., 50-100ms max wait).
- Requests exceeding wait timeout must be rejected with `503`.
- No unbounded queueing is allowed.

### 4.4.3 Scope
- Apply limiter to all DB-bound endpoints:
  - bookings
  - analytics
  - admin queries
  - state transitions (`accept/start/complete/cancel`)
- DB-bound endpoints are any request path that performs SQL queries, transactions, or PostgreSQL reads/writes.
- Middleware must be applied **after auth** but **before DB access layer**.
- Exclude:
  - `/health`
  - lightweight cached endpoints (if no DB access)

### 4.4.4 Expected behavior
- Prevents DB overload, PgBouncer queue explosion, and cascading latency spikes.
- Ensures stable p95 latency and predictable throughput under load.
- Under sustained saturation, system must prefer fast failure (`503`) over slow responses.
- Protect p95 latency instead of maximizing throughput.

### 4.4.5 Tuning strategy
- Start with `limit = 600`.
- Adjust based on DB CPU usage, PgBouncer `waiting_clients`, and p95 latency trends.

### 4.4.6 Observability
- Track:
  - current in-flight requests
  - queued requests
  - rejected requests (`503` count)
- Expose metrics for limiter saturation events and average wait time.

---

## 5. UUID Validation Audit

## 5.1 Routes using `:id`-like params (audit)
- Booking: `/:id` + `/:id/{cancel|accept|start|complete|tracking|match-status}`
- Location: `/helper/:id`
- Addresses: `/:id` (update/delete)
- Cart: `/items/:id`
- Services: `/:id/{details|addons}` and admin `/:id` patch/delete
- Helper: `/me/invites/:bookingId/decline`
- Admin: `/users/:id/{suspend|unsuspend}`, `/bookings/:id/cancel`, `/promotions/:id{,/disable}`
- Roomies: `/groups/:id/...`, `/members/:memberID/topup`, `/debts/:debtID/...`, `/groups/:id/{ledger|vault}`
- Non-UUID keyed params (string keys): `/app/screens/:key`, `/admin/content/screens/:key`, `/admin/config/:key`

## 5.2 Current status
- UUID checks are present across audited UUID route handlers before service/repository calls.
- Remaining risk is **consistency drift** (repeated inline checks).

## 5.3 Standardization plan
- Introduce one shared helper/middleware pattern:
  - `RequireUUIDParam(c, "id", "booking id")`
  - centralizes error shape + message policy
- Add handler tests for every `:id` route class to enforce “invalid UUID => 400, never DB hit”.

## 5.4 Goal
- Zero invalid UUIDs reaching repository/DB layer.

---

## 6. Rate Limiter Resilience Design

## 6.1 Current issue
- Auth endpoints (`/auth/*`) are currently grouped with public limiter behavior, so Redis outage behavior is not strict enough for abuse-sensitive flows.

## 6.2 Target design
1. **Primary limiter:** Redis sliding-window/Lua.
2. **Fallback:** bounded in-memory token bucket per key with TTL + capped bucket map.
3. **Policy split:**
   - **Fail-closed:** OTP send/verify, Firebase auth, admin routes, booking state transitions (`accept/start/complete/cancel`), any sensitive mutation.
   - **Fail-degraded (bounded fallback):** health/read-heavy public endpoints, catalog/content reads, non-sensitive queries.

## 6.3 Controls
- Explicit degraded-mode response headers.
- Distinct counters for Redis failure, fail-closed reject, fallback allow/reject.
- Hard memory bounds on fallback key-space.

---

## 7. Observability Plan

## 7.1 Database
- Enable/verify:
  - `pg_stat_statements`
  - slow query log (`log_min_duration_statement`)
  - temp-file and lock wait visibility
- Metrics:
  - top queries by total time, mean time, calls
  - temp bytes, shared/local block reads, lock waits

## 7.2 API
- RED metrics per route:
  - RPS
  - latency avg/p95/p99
  - error rate (4xx/5xx split)

## 7.3 PgBouncer
- `SHOW STATS/POOLS` collection:
  - active server conns
  - waiting clients
  - avg wait/use times

## 7.4 Redis
- limiter script latency
- command latency p95
- keyspace/memory pressure
- cache hit/miss where cache is used

## 7.5 Runtime/system
- CPU, memory, GC pause, goroutines, open file descriptors.

## 7.6 Alert thresholds (initial)
- API p95 > 500ms (5m), p99 > 1s (5m), 5xx > 1%.
- PgBouncer waiting clients > 50 for 3m.
- DB active connections > 85% of safe cap for 5m.
- Slow queries > 250ms sustained; temp-file bursts beyond baseline.
- Redis p95 latency > 20ms or repeated limiter script failures.
- Process memory > 85% and rising, goroutines > 2x baseline.

## 7.7 Dashboard structure
1. **API SLO panel** (RPS, p95/p99, errors)
2. **DB query panel** (top SQL, temp usage, lock waits)
3. **PgBouncer panel** (pool usage, waiters, queue time)
4. **Redis panel** (latency/errors/hit ratio)
5. **Runtime panel** (CPU, memory, goroutines, GC)

---

## 8. Performance Projections (post-fix estimates)

- **RPS:** +60% to +120% vs current mixed-load baseline (target ~2500–4500 sustained, traffic-mix dependent).
- **Latency:** at ~1000 active concurrency, p95 expected to drop from ~800ms+ range toward ~220–350ms after rollup/query+pool tuning.
- **Concurrency capacity:**
  - active request concurrency expected to move from ~1000–2000 band toward ~3000–5000 before severe degradation.
  - connected user capacity target remains ~10,000 with realistic think-time and mixed read/write profile.

---

## 9. Risks & Trade-offs

1. **Rollup freshness lag:** dashboards become near-real-time, not perfectly real-time.
2. **Partition operations overhead:** monthly partition maintenance/runbook needed.
3. **Transaction pooling constraints:** session-level DB features/prepared-session assumptions must be avoided.
4. **Fallback limiter divergence:** local fallback is per-instance; global fairness is approximate during Redis outage.
5. **Mis-tuned pool sizes:** overly high pool sizes can reintroduce queueing and tail spikes.

---

## Implementation order (for Phase 3 approval)
1. Query rewrites + index additions
2. Rollup tables/workers/materialized strategy
3. PgBouncer tuning rollout
4. App DB pool tuning
5. UUID validation standardization/tests
6. Rate limiter policy split + fallback hard bounds
7. Observability/alerts/dashboards

After each step in Phase 3: run load tests and record delta for RPS, p95/p99, DB wait, and error rate.

---

## Review gate status
- Phase 1 complete: plan only.
- No implementation performed in this phase.
- Waiting for approval before Phase 3 execution.
