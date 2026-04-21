# Backend Scalability & Reliability Plan (Target: ~10,000 Concurrent Users on Current Hardware)

## 1. Current System Analysis

### 1.1 Observed bottlenecks (from recent load/stress/soak findings)
- **Concurrency degradation begins near ~1000 concurrent requests**:
  - ~1000 conc: p95 ~803–850ms, p99 ~971ms
  - ~1200 conc: p95 ~1050ms
  - ~1500 conc: p95 ~1318ms
  - ~2000+ conc: multi-second p95/p99
- **Sustained soak (30 min @ 200 conc)** showed latency drift:
  - First 5-min avg p95 ~333ms
  - Last 5-min avg p95 ~538ms
- **PostgreSQL saturation risk**:
  - `max_connections=100`; pgbench fails around high client counts with `too many clients`
  - App pool currently fixed (`MaxConns=25`, `MinConns=5`), no external connection governor
- **Analytics query shape is expensive at scale**:
  - Seq scan + external sort on large `analytics_events` windows (temp file usage observed)
- **Rate limiter behavior**:
  - Redis-backed sliding window works, but currently **fail-open** on Redis script failure (availability > security)
- **Validation and error handling gaps**:
  - Some UUID path flows still return 5xx and leak DB internals (e.g., SQLSTATE in response)
- **JWT security posture**:
  - Default-like secret usage was possible; no formal key rotation lifecycle in runtime verification path.

### 1.2 Why the system degrades near ~1000 users
- High per-request cost on authenticated paths (JWT parse + middleware + DB touch + Redis limiter roundtrip).
- No explicit separation between **active DB-bound traffic** and **connection admission control**.
- Expensive analytics reads can contend for DB CPU/memory under load.
- Error-heavy malformed traffic paths consume capacity with 5xx and internal DB failures instead of fast 4xx rejects.
- Rate limiting depends on Redis health and lacks hardened degraded-mode policy.

---

## 2. Target Architecture for ~10k Concurrent Users (Same Hardware)

### 2.1 Throughput model
- Support **~10k concurrent connected users** by reducing per-request backend work and controlling DB concurrency.
- Keep DB-bound active request concurrency tightly bounded while allowing high connection concurrency at app layer.

### 2.2 Core architecture changes
1. **Connection governance layer (PgBouncer)** on same host
   - Transaction pooling between app and PostgreSQL.
   - App pool tuned lower and steadier; PgBouncer absorbs bursty connection fan-out.
2. **Hot-path request optimization**
   - Fast-fail input validation at handler boundary (UUID, schema, body size).
   - Centralized sanitized error mapping to avoid heavy DB exception paths.
3. **Cache-first read strategy**
   - Strengthen Redis use for high-read endpoints (content/config/derived analytics snapshots).
   - Explicit cache-key versioning/invalidation to avoid stale or stampede behavior.
4. **Analytics read offload**
   - Pre-aggregated rollups/materialized views for dashboard/funnel windows.
5. **Security hardening in auth path**
   - Strong JWT secret policy + key-id based rotation set for verification.
6. **Resilience-aware rate limiting**
   - Primary Redis limiter + bounded local fallback behavior for degraded Redis scenarios.
7. **Observability-first operations**
   - Query-level visibility, endpoint latency/error histograms, saturation signals.

---

## 3. Detailed Fix Plan (Mapped to Requirements)

| Area | What is wrong currently | Exact solution | Expected impact |
|---|---|---|---|
| **a. Strong JWT secrets + rotation** | Weak/default secret risk and no formal multi-key verification lifecycle | Enforce strict secret policy (length/entropy/blocked defaults), require active key ID, support previous verification keys by `kid`, documented rotation runbook | Eliminates trivial token forgery risk; enables zero-downtime key rotation |
| **b. Strict UUID validation** | Some routes still let invalid UUIDs reach DB | Validate all UUID path/query IDs at handler boundary; reject with consistent 400 | Reduces DB error load, removes avoidable 5xx, improves resilience under fuzz traffic |
| **c. Sanitized error handling** | Internal DB errors leak to client | Centralized error classifier/mapping (domain errors -> 4xx, infra errors -> sanitized 5xx); never return raw SQL/stack details | Better security posture, lower response payload variability, cleaner SLO/error budget tracking |
| **d. DB connection governance** | Direct app-to-DB pooling only; connection spikes can hit DB limit | Introduce PgBouncer (transaction pooling), tune app `MaxConns` + PgBouncer pool sizes/queues/timeouts; reserve DB headroom for admin/maintenance | Prevents connection storms, stabilizes DB latency, increases effective concurrency handling |
| **e. Analytics query optimization** | Large-window scans/sorts on raw event table | Add targeted indexes + rollup tables/materialized views (minute/hour/day), refresh cadence, query rewrites to rollups | Significant DB CPU/IO reduction; stable analytics latency under load |
| **f. Rate limiter redesign** | Redis script failure currently fail-open | Introduce policy switch: fail-closed for sensitive endpoints, bounded local token-bucket fallback for general endpoints, explicit degraded-mode telemetry | Keeps abuse resistance during Redis impairment without total service collapse |
| **g. Production observability** | Limited deep visibility for query and saturation hotspots | Enable `pg_stat_statements`, RED metrics (rate/errors/duration), DB pool + PgBouncer metrics, Redis limiter metrics, dashboards + alerts | Faster detection, diagnosis, and safer capacity tuning for 10k target |

---

## 4. Scaling Strategy Without New Hardware

### 4.1 Maximize throughput via optimization (not expansion)
- Keep expensive DB operations bounded and predictable.
- Shift high-frequency reads to cache/rollup artifacts.
- Convert malformed traffic into cheap early 4xx responses.
- Prevent connection-level thrash with PgBouncer queueing/backpressure.
- Reduce tail latency amplification by removing costly exception paths.

### 4.2 Concurrency handling model
- Treat 10k concurrency as:
  - Large connected population
  - Controlled number of active DB-bound transactions
- Use admission control and queueing where needed instead of over-parallelizing DB work.

---

## 5. Performance Projections (Post-optimization)

> Projections assume same hardware, production-grade tuning, and mixed traffic profile (read-heavy + moderate writes), not worst-case all-write saturation.

- **Concurrent connected users**: target **~10,000**
- **Sustained active API throughput**: **~2,500–4,000 RPS** (mix-dependent)
- **Latency targets**:
  - Read-heavy authenticated endpoints: avg **<120ms**, p95 **<300ms**
  - Write/transactional endpoints: avg **<220ms**, p95 **<550ms**
- **Error budget under load**:
  - 5xx rate **<0.5%** in steady-state load tests
  - No internal DB error leakage in external responses

---

## 6. Risk Analysis

### 6.1 Risks that may still fail at 10k
- Bursty write-heavy traffic can still exceed DB CPU limits even with pooling.
- Cache invalidation errors can cause stale data or cache misses/stampedes.
- Poorly tuned fallback rate limiting can either over-block legit users or under-block abuse.
- Rollup refresh lag can affect analytics freshness.

### 6.2 Trade-offs
- Transaction pooling improves scale but may constrain session-level DB features.
- Strong fail-closed limiter policy improves security but can reduce availability during Redis incidents.
- More observability adds minor overhead but is necessary for safe high-concurrency operation.

---

## 7. Step-by-Step Implementation Plan (independently testable)

1. **Auth security foundation**
   - Finalize strict JWT secret policy + key rotation config contract (`active key + previous keys`).
   - **Checkpoint:** startup rejects weak/default secrets; rotated keys verify old tokens.

2. **Universal input guardrails**
   - Add/normalize UUID validation for every ID-bearing handler path.
   - **Checkpoint:** malformed IDs always return 400 (never 5xx).

3. **Centralized error sanitization**
   - Introduce domain-safe error mapping and remove raw DB error exposure.
   - **Checkpoint:** fuzz tests show no SQLSTATE/internal leakage.

4. **DB governance with PgBouncer**
   - Add PgBouncer sidecar/process + connection and timeout tuning.
   - Tune app pool and DB max connection strategy with reserved headroom.
   - **Checkpoint:** connection spikes no longer trigger `too many clients`.

5. **Analytics read-path optimization**
   - Add indexes for top access patterns and rollup/materialized structures.
   - Rewrite admin analytics reads to rollups where possible.
   - **Checkpoint:** analytics endpoints avoid large seq-scan/sort under load.

6. **Rate limiter resilience redesign**
   - Implement endpoint-class policy (fail-closed for sensitive, bounded degraded fallback for general).
   - **Checkpoint:** Redis fault injection keeps policy-compliant behavior.

7. **Observability and SLO instrumentation**
   - Enable pg_stat_statements, endpoint RED metrics, DB/Redis/pool gauges, alerts.
   - **Checkpoint:** dashboards show latency/error/saturation with actionable alerts.

8. **Progressive load validation**
   - Re-run baseline → stress → spike → 60-min soak against hardened build.
   - **Checkpoint:** projected latency/error targets met or tuning iteration triggered.

---

## 8. Testing Strategy

### 8.1 Load testing approach
- **Baseline ladder:** 100 → 500 → 1000 → 2000 → 5000 active request concurrency
- **Spike tests:** sudden 10x jumps with recovery windows
- **Soak tests:** 60-min sustained mixed workload
- **Fault injection:** Redis unavailable, DB unavailable, slow query scenarios
- **Security/fuzz:** malformed JSON, invalid UUIDs, oversized payloads, auth abuse patterns

### 8.2 Metrics to monitor
- API: RPS, avg latency, p95, p99, 4xx/5xx split
- DB: active connections, wait/queue time, slow queries, temp files, lock waits
- PgBouncer: client waits, server utilization, pool saturation
- Redis: ops/sec, hit/miss, latency, limiter error/degraded mode counters
- App runtime: CPU, memory, goroutines, GC pause

### 8.3 Success criteria
- Stable operation at **~10,000 concurrent connected users**
- p95 and error targets in Section 5 met for sustained and spike conditions
- No secret-policy bypass, no raw internal error leakage
- No DB connection exhaustion under planned stress profiles

---

## Review Gate Status

- **Phase 1 complete:** Plan prepared.
- **No implementation performed in this phase.**
- Awaiting approval to proceed to code/config changes.
