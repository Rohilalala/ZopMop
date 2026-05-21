# Findings — Rate Limiting, DoS, Cost Attacks

## Summary
Layered rate-limiter exists (Redis sliding-window + local token-bucket pre-filter + per-route named buckets). Sensitive auth path is fail-closed. BUT: the OTP rate limiter on top of it fails OPEN on Redis errors (B-007), Cashfree webhook idempotency is unconfirmed, websocket booking-tracking is on the public bucket with no auth, and several economic-DoS paths (LLM, SMS, dispatch fan-out) have only loose ceilings.

Totals (this domain): 1 CRITICAL, 4 HIGH, 7 MEDIUM, 5 LOW.

## Methodology
- Read `internal/middleware/ratelimit.go:40-71` for all limit configs.
- Mapped each `RateLimiter`/`NamedRateLimiter` binding in `cmd/api/main.go` (lines 248,249,519,524) and `cmd/crm-api/main.go` (lines 320,341,358).
- Read `internal/auth/ratelimit.go` end-to-end.
- Read `internal/payments/cashfree.go:420-447`.
- Read `cmd/api/main.go` Fiber config + crons (lines 192-209, 648-700).
- Cross-checked with prior audit `audit/findings/rate-limiting.md` (8 MED + 6 LOW).
- code-review-graph attempted; fell back.

---

## Findings

### D-001 [CRITICAL — pre-existing] OTP-send economic DoS — 5/IP × 15min ceiling allows attacker network to burn SMS budget; no global circuit breaker
- **Location:** `internal/auth/ratelimit.go:33-41`, `cmd/api/main.go:488-489`.
- **Description:** Per-phone 3/15min and per-IP 5/15min are the only ceilings. Combined with the `is_new_user` enumeration leak (B-006), an attacker can probe random Indian-number space at ~50 IP × 5 = 250 sends / 15 min and burn ₹0.30/SMS × 250 × 4 = ₹300/hour, ₹7200/day per attacker. With even a 100-IP botnet, that's ₹15k+/day. No global ceiling. No Sentry alert. No carrier-side spend cap documented.
- **Exploit:** Vendor billing depletion + customer SMS receipt flooding (annoyance ban risk with telcos).
- **Fix:** (1) Global send budget per minute (e.g. 60 sends/min total across the project, configurable). (2) Sentry alert when 50% of global cap consumed in any 5-min window. (3) Confirm Message Central dashboard has hard spend cap. (4) Drop `is_new_user` from response (per B-006).
- **Evidence:** `internal/auth/ratelimit.go:36-37`, `internal/auth/handler.go:319-330`. Prior: `audit/findings/rate-limiting.md:101-152`.

### D-002 [HIGH — NEW] OTP rate-limiter fails OPEN on Redis errors (also B-007)
- See finding B-007. Belongs in DoS framing too: Redis hiccup → unlimited sends. Combined with D-001 it's a CRITICAL combo.
- **Fix:** Fail closed on the OTP send path; log + alert.

### D-003 [HIGH — pre-existing] Zop (LLM) chat token cost-DoS
- See C-001. Up to 100 chat req/min/user × ~unlimited body × ~unlimited tokens = OpenRouter blowout. No per-user daily budget. No global circuit breaker.
- **Fix:** Per-user daily token cap in Redis (`zop:tokens:<userID>:<YYYYMMDD>`); reject when exceeded.

### D-004 [HIGH — pre-existing] Cashfree webhook idempotency not confirmed
- See C-006. Replay within the timestamp skew window can re-trigger downstream side effects (wallet credit, booking advance) unless `dispatchCashfreeEventTx` dedupes by event_id.
- **Fix:** Insert-only event_id table; gate side effects on insert success.

### D-005 [HIGH — NEW] WebSocket booking-tracking on `publicLimiter` (30/min IP) with no auth at upgrade
- **Location:** `cmd/api/main.go:533`.
- **Description:** `bookingTrackWS.RegisterTrackingWS(api.Group("/bookings", publicLimiter))` — public limiter is local-fallback (fails permissive within local cap), no `authMiddleware`. If JWT isn't validated during upgrade, anyone can open a WS to track any booking ID (or fan out across IDs). WS holds memory + goroutines server-side until close.
- **Exploit:** (a) Authorization bypass on live booking location data (per AuthN/Z B-012). (b) Connection-exhaustion DoS — 30 IPs × 30 conns/min = 900 long-lived WS per minute. Tracked in `dbBoundLimiter`? No — WS bypasses HTTP timeout middleware.
- **Fix:** Validate JWT during upgrade. Cap concurrent WS per user (Redis-tracked). Idle timeout: close any WS idle > 10 min.
- **Evidence:** `cmd/api/main.go:533`. Confirm WS handler does its own auth.

### D-006 [MEDIUM — pre-existing] PublicRateLimit is `local-fallback` (in-process bucket) — multi-replica deployments multiply the effective ceiling
- **Location:** `internal/middleware/ratelimit.go:43`.
- **Description:** On Redis failure, the local token bucket caps at MaxRequests per Window per replica. With N replicas, attacker gets 30 × N req/min. Acceptable as defence-in-depth; risk is that operators assume the 30/min is hard.
- **Fix:** Document expected replica count, scale local-fallback cap inversely. Or only fail-closed.
- **Evidence:** `internal/middleware/ratelimit.go:43,73-130`.

### D-007 [MEDIUM — pre-existing] BookingCreateRateLimit 3/min — but per-user, not per-customer phone, not per-IP
- See `audit/findings/rate-limiting.md` and `internal/middleware/ratelimit.go:56`.
- **Description:** A single attacker who can create N fresh customer accounts (via D-001 SMS burn) gets N × 3 bookings/min — sufficient to wedge dispatch.
- **Fix:** Layer with global booking-create per minute; reject by IP when global trips.

### D-008 [MEDIUM — pre-existing] Dispatch/matching crons have no concurrency cap per shard
- See `audit/findings/devops.md:480-524`.
- **Description:** Multi-instance crons not gated by leader election (per prior audit). With ≥2 replicas, two dispatchers race for the same pending booking.
- **Fix:** Postgres advisory lock per cron name; only the lock holder runs.

### D-009 [MEDIUM — pre-existing] Outbox worker has no backpressure on consumer panics
- **Location:** Outbox worker per `cmd/api/main.go:405-408`.
- **Description:** Handler panics could re-queue indefinitely without exponential backoff. Confirm `outbox.Worker` retry caps.
- **Fix:** Cap retries (e.g. 10) then dead-letter.

### D-010 [MEDIUM — pre-existing] CRM admin login limiter is per-IP only; distributed bruteforce escapes
- See B-019. Distributed login → no per-email lockout.

### D-011 [MEDIUM — pre-existing] DBConcurrencyLimiter (600 in-flight, 75 ms wait) — verify backpressure under spike
- **Location:** `internal/middleware/concurrency.go:26`, `cmd/api/main.go` reads `DB_BOUND_MAX_INFLIGHT=600, DB_BOUND_QUEUE_WAIT_MS=75`.
- **Description:** Per-process. With 2 replicas, 1200 simultaneous DB-touch requests. Postgres pool is 80 (`DB_POOL_MAX_CONNS=80`), so the limiter is much looser than the pool. Effective bottleneck is the pool — but spike behavior is "queue 75 ms then 503," which under a burst will look like a global outage.
- **Fix:** Tighten `DB_BOUND_MAX_INFLIGHT` to match pool size with some headroom (e.g. 100); keep wait short.

### D-012 [MEDIUM — pre-existing] Push scheduler (CRM cron) has no per-user/per-segment ceiling
- See `cmd/crm-api/main.go:245`.
- **Description:** Push scheduler dispatches scheduled marketing pushes via outbox. If schedule misconfigured (e.g. broad segment + tight interval), the FCM cost / user-annoyance damage is uncapped.
- **Fix:** Per-user push throttle (e.g. ≤ 3/day default, audit on overrides).

### D-013 [LOW — pre-existing] OTP verify counter resets on success, not failure
- **Location:** `internal/auth/ratelimit.go:97`.
- **Description:** A successful verify resets the per-phone counter. Brute-force resilience reduces to "5 attempts before any successful try." Acceptable.
- **Fix:** None required if 5 is acceptable. Otherwise leave the counter at its current value post-success (defence-in-depth).

### D-014 [LOW — pre-existing] No connection-pool exhaustion guard for OpenRouter / vendor calls
- **Description:** Each LLM call holds an HTTP connection until vendor responds. With 100 chat/min/user concurrent, vendor pool exhaustion looms.
- **Fix:** Cap concurrent in-flight LLM requests globally (semaphore). Reject 503 with `Retry-After` when capped.

### D-015 [LOW — pre-existing] Long-running cron has no graceful pause for migration window
- See `audit/findings/devops.md`.

### D-016 [LOW — pre-existing] Health endpoint `publicLimiter` (30/min IP) — kubernetes/Railway probes may share IP and trip
- **Location:** `cmd/api/main.go:256`.
- **Description:** Probes ride 30/min/IP. Multiple probes from same gateway → false-positive throttling on a critical path.
- **Fix:** Health endpoints carry a dedicated, no-rate-limit handler. Move probe behind a secret-token check if security requires.

### D-017 [LOW — NEW] No global request inflight cap at server boot — Fiber default is unlimited
- **Description:** `BodyLimit` caps single requests but nothing caps concurrent connections per server. Slowloris-style attacks possible.
- **Fix:** Set `Fiber.Config.Concurrency = N` (matched to expected worker capacity) at `cmd/api/main.go:192`.

---

## Cross-cuts
- D-001 + D-002 + B-006 → combined CRITICAL economic + privacy story for SYNTHESIS top-10.
- D-003 ↔ C-001.
- D-005 ↔ B-012 (WS no-auth).
- D-004 ↔ C-006.

End of findings.
