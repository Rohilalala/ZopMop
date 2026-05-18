# Performance & Scalability Audit — ZopMop Backend

Scope: `App/househelp-api/`. Generated 2026-05-15 by Subagent 5.

Prior load-test data referenced throughout — see `loadtest/results/` and
`report.json`. Numbers cited inline come from those files.

---

## Executive summary

Severity counts: **Critical 2 / High 8 / Medium 9 / Low 5 / Nit 2**

The backend is broadly sound for low-traffic operation and has good
hygiene around recently-added concerns (cron Stop hooks, SKIP LOCKED
claim queries, panic-recover, idempotency middleware). The prior load
tests (phase2 @ ~60 rps, phase3_geo @ 6157 rps) however expose two
fundamental ceilings that will surface long before production scale:

1. **The matching engine is per-request, in-process, and stateful**
   (in-memory polling goroutines, 25s per-pro chain). Phase2 booking
   creation already shows p95 = 1369 ms at <60 rps with status_5xx
   spikes. The chain cannot survive a process restart and is unsafe
   under Railway's auto-scaled replicas (multiple invite chains can
   race per booking).
2. **No protection on the hot `/me` and `/zones/check` endpoints under
   burst** — phase3_geo recorded **94.5 % failure rate at 6157 rps**
   (`http_req_failed.value = 0.9458`). The DB-bound concurrency limiter
   (`DB_BOUND_MAX_INFLIGHT=600`) is doing most of the load shedding;
   cache-aside on hot reads (services, zones, public config snapshot)
   would meaningfully relieve it.

Key prior load-test numbers:

| File | Headline |
| --- | --- |
| `loadtest/results/phase1.json` | Baseline 1-VU smoke: bookings_create p95 = 60.7 ms, sdui_home p95 = 16.2 ms, every threshold marked `false` because no traffic met the 200 ms bar |
| `loadtest/results/phase2.json` | 185 VU, 60 rps: cust_book p95 = **1369 ms (over 1500 ms threshold? false — barely under)**, http_req_failed = 45.8 %, status_5xx = 50, status_429 = 1770 |
| `loadtest/results/phase3_herd.json` | 300 VU thundering-herd burst: 300 / 300 booking creates succeeded, p95 = 1022 ms, but the burst_latency `p(95)<3000` threshold **passed**; `http_req_failed.rate<0.10` threshold **failed** (rate = 0 — looks like a metric inversion bug in the test, but tracked) |
| `loadtest/results/phase3_geo.json` | 300 VU sustained at 6157 rps: **94.5 % requests failed** (`http_req_failed = 0.9458`); `me_latency.p(95)<1500` threshold **failed**; geo_check_latency `p(95)<800` **failed**; only 30 / 12000 geo checks returned 200. This is the true scalability ceiling under the current pool sizing. |
| `loadtest/results/stress_report_final.json` | E2E DB-integrity stress: 938 bookings, 100 helpers, 1000 customers — every assertion passed including `helpers_in_redis_geo = 100` (no missing GEO entries) and trigger `fn_bookings_reject_dup_within_hour` held |
| `report.json` | Aggregate integrity: 99.78 %; **50 mismatched `lifetime_value` rows on users** (49,900 paise everywhere; expected 0) — points at lifecycle drift in lifetime_value bookkeeping (not perf, flagged for the data-integrity subagent) |

---

## Findings

```
[SEVERITY: Critical]
[FILE: internal/matching/dispatch.go:295-360, cmd/api/main.go:577-580]
[CATEGORY: Performance / Scalability — multi-instance safety]
Finding:
InviteChain runs as an in-memory cron goroutine. Per pro it (a) writes
the invite to Redis, (b) sends the FCM data push, then (c) busy-polls
`bookings.helper_id` every 5 s for up to 25 s waiting for accept
(`perProInviteWait = 25 * time.Second`). Multiple replicas of `api`
will independently start their own ScheduledDispatcher /
StealthDispatcher / RebookScanner goroutines (cmd/api/main.go:577-580
`go matching.NewScheduledDispatcher(dispatcher).Start(cronCtx)` etc.).
Although `claimNext` uses SELECT FOR UPDATE SKIP LOCKED to gate the
booking-row pickup, the chain itself spends the next several minutes
running in-memory: if a second replica picks up the SAME booking
because the first replica's row-level lock has been released (the
claim tx commits before chain starts; status is moved to 'searching'
in stealth_dispatch but the nightly batch only updates the booking
inside InviteChain, not before), the two chains can both fire
SCHEDULED_INVITE pushes and race the accept window.

Impact:
- Duplicate FCM pushes to every pro on the chain — pro sees the same
  booking twice and the second accept call hits a 409.
- Wasted booking-pool burn: each instance independently exhausts the
  preferred + general pool.
- Process restart loses all in-flight chains; bookings that were 5 s
  away from acceptance silently fall through to "no_pros_found" at
  the next sweeper tick, with no resume.
- Cannot horizontally scale `api` on Railway without disabling these
  goroutines on all but one replica (which is not currently possible
  via env var).

Fix:
1. Move chain state into Redis or Postgres so a restart resumes from
   the same pro. A `booking_invite_chain` row keyed on (booking_id,
   helper_id, sent_at, deadline_at) lets a sweeper reissue when the
   process that issued the invite is dead.
2. Gate cron starts behind a leader-election lease (Redis SET NX with
   TTL, or `pg_try_advisory_lock`). Only the leader runs the
   dispatchers.
3. Replace polling with LISTEN/NOTIFY on `bookings_accept` so 5 s
   round-trips disappear (~150 fewer round-trips per 30-pro chain per
   the comment at internal/matching/dispatch.go:46).

Evidence:
- internal/matching/dispatch.go:43-53 (constants, pollInterval = 5s)
- internal/matching/dispatch.go:295-360 (inviteSinglePro polling loop)
- cmd/api/main.go:577-580 (unconditional cron starts)
- internal/matching/scheduled_dispatch.go:157-184 (claim tx commits
  before chain runs)
- Prior audit memo: `feature_dev:feature-dev` review of pro-side
  audit fixes lists "stats row API + offline banner" as deferred but
  not this concurrency hazard — net-new finding.
```

```
[SEVERITY: Critical]
[FILE: pkg/database/postgres.go:30-37, .env.example:DB_POOL_*]
[CATEGORY: Performance / Connection pool]
Finding:
DB_POOL_MAX_CONNS = 80 per replica with DB_BOUND_MAX_INFLIGHT = 600
in-process queue. Railway's hobby/dev Postgres caps connections at
~22 (free) / 64 (developer) / 100 (production). On a single replica
the pool consumes 80 conns; on two replicas (Railway autoscale) it
would request 160 — exceeding even the production cap. The pool
defaults panic on pool exhaustion at the gate, but the bound limiter
queues 600 deep with a 75 ms `DB_BOUND_QUEUE_WAIT_MS` budget — so 520
of every 600 queued requests will time out at 75 ms before reaching
a connection. Phase3_geo's 94.5 % failure rate corroborates this:
6157 rps × ~20 ms p95 latency = ~125 in-flight concurrent requests,
which combined with cron + tracking-WS pulls quickly fills the 80-
conn pool.

Impact:
- A single Railway scale-up event will exceed the prod Postgres
  connection cap and refuse new connections — outage.
- Under burst, the 75ms queue wait causes mass 503/timeout fan-out
  even though the DB is healthy.

Fix:
1. Pin `DB_POOL_MAX_CONNS` to `floor(prod_db_max_connections /
   max_replicas) - reserved_admin_conns`. Document the Railway
   Postgres plan's connection cap in CLAUDE.md.
2. Consider PgBouncer / Railway-Pgpool in front of Postgres for any
   replica count > 1.
3. Raise `DB_BOUND_QUEUE_WAIT_MS` to 250-500 ms once the pool is
   right-sized; 75 ms is below normal cold-conn establishment time.

Evidence:
- pkg/database/postgres.go:30-37 (defaults 80 / 20)
- .env.example "DB_POOL_MAX_CONNS=80", "DB_BOUND_MAX_INFLIGHT=600",
  "DB_BOUND_QUEUE_WAIT_MS=75"
- phase3_geo.json `http_req_failed.value = 0.9458015845527752` —
  349 538 failures of 369 568 requests over ~60 s
- Railway prod URL: `turntable.proxy.rlwy.net:47710` (REPO_MAP.md
  line 182) — TCP proxy means every reconnect is a real TCP RTT, so
  conn-thrash under churn is doubly costly.
```

```
[SEVERITY: High]
[FILE: pkg/database/redis.go:35-39]
[CATEGORY: Performance / Connection pool — Redis]
Finding:
Redis pool is hard-coded: `opt.PoolSize = 10`, `MinIdleConns = 3`,
read/write timeouts 3 s. No env override and no per-replica scaling.
At 60 rps with rate limiter + idempotency + matching engine + gmaps
cache + content cache all hitting Redis, p95 latency added by Redis
backpressure is non-trivial. Phase2 cust_book p95 = 1369 ms includes
Redis hops for rate-limit Lua + invite-set writes.

Impact:
- Pool exhaustion on bursts; redis.PoolStats() unmeasured.
- No way for ops to scale Redis concurrency without code change.

Fix:
1. Make pool size env-driven (e.g. `REDIS_POOL_SIZE`, default 50).
2. Expose Redis pool stats alongside `database.PoolStats(dbPool)` in
   the `/api/v1/admin/runtime/metrics` handler (cmd/api/main.go:627)
   so the admin dashboard surfaces it.

Evidence: pkg/database/redis.go:35-39.
```

```
[SEVERITY: High]
[FILE: internal/location/service.go:11-50, internal/matching/engine.go:242-269]
[CATEGORY: Performance / Redis hygiene — unbounded GEO set growth]
Finding:
The Redis GEO set `helpers:locations` (ZSET internally) has NO TTL
and is never trimmed except via the explicit `RemoveHelperLocation`
when a helper toggles offline. Each `UpdateHelperLocation` does
GEOADD + sets a separate 5-minute `helper:active:<id>` marker. The
matching engine drops candidates whose marker has expired but does
not remove them from the GEO set. As helpers churn (banned, deleted,
test fixtures, rotated IDs), the GEO set grows unbounded and every
GEOSEARCH (insights, ETA, dispatch) must scan it.

The compliance-purge tests at
internal/compliance/redis_purge_test.go:38 confirm the same:
`helper:active:` markers are cleared on user deletion but the GEO
entry is removed only through the dedicated purge service — never
on its own TTL.

Impact:
- Slow degradation of GEOSEARCH latency.
- After enough churn, memory pressure on Redis.
- Booking matching considers ghost helpers (filtered out later via
  the `helper:active:` EXISTS pipeline, but they still cost a row in
  the candidate set and a Redis pipeline cmd each).

Fix:
1. Add a periodic sweeper that runs `ZRANGE helpers:locations 0 -1`,
   pipelines `EXISTS helper:active:<id>` for each, and `ZREM`s any
   missing markers. Once-an-hour is enough.
2. Alternatively, on every location update do
   `pipe.ZRemRangeByScore(...)` against `helpers:active:set` keyed
   by Unix timestamp so expired entries fall out automatically.

Evidence:
- internal/location/service.go:11-14 (locationExpiry = 5m, but only
  on the marker key, not the GEO entry)
- internal/matching/engine.go:242-269 (filter step accepts the cost)
- stress_report_final.json detail "soft check — markers TTL out
  after 5 min; fails only if every marker is gone" — implicit
  acknowledgement that the GEO set has different lifetime semantics
  than the markers.
```

```
[SEVERITY: High]
[FILE: internal/matching/engine.go:454-485]
[CATEGORY: Performance / Goroutine fan-out — uncontrolled parallelism]
Finding:
Per booking, the walking-time filter spawns one goroutine per
candidate (up to candidateFetchLimit = 50). Each goroutine calls
Google Maps Distance Matrix — even with the 5-min Redis cache, every
cache miss is one outbound HTTPS call with 5 s timeout. With 60
concurrent bookings (phase2 cohort), that is 60 × 50 = 3000
goroutines all racing the same 10 s ctx, possibly hitting Google's
QPS limit and forcing a fallback. There is no semaphore, no
work-stealing pool, no priority queue.

Impact:
- Google Maps quota burn under burst.
- Process-level goroutine count balloons during traffic spikes.
- The Distance Matrix API has per-second quotas; bursts get 429'd
  silently (the helper returns 0 minutes on error, which the filter
  treats as "unknown — drop"), so a quota spike masquerades as
  "no pros available".

Fix:
1. Introduce a process-wide semaphore around Google Maps calls
   (e.g. buffered chan with capacity 50 — enough for one full
   candidate set, conservatively enough that 10 simultaneous
   bookings serialise rather than fanning out to 500 goroutines).
2. Or use `golang.org/x/sync/errgroup.WithContext` + `SetLimit(N)`
   to bound parallelism per booking AND per process.
3. Increase the Maps cache TTL beyond 5 minutes for walking-time
   pairs — the underlying physical distance doesn't change.

Evidence:
- internal/matching/engine.go:459 `for i, c := range candidates {
  go func(i int, c HelperCandidate) {`
- internal/googlemaps/client.go:122 `_ = c.rdb.Set(ctx, key,
  minutes, 5*time.Minute).Err()` — 5-min TTL on walking minutes
  cache.
- internal/matching/engine.go:26 `candidateFetchLimit = 50`
```

```
[SEVERITY: High]
[FILE: internal/services/service.go, internal/zones/service.go]
[CATEGORY: Performance / Missing cache on hot reads]
Finding:
The services catalog (`GET /api/v1/services`) and zones check
(`GET /api/v1/zones/check`) hit Postgres on every request — no Redis
caching at the service layer. Phase1 shows services p95 = 11.6 ms
and zones_check p95 = 6.9 ms at 1 VU; at 6157 rps these become major
contributors to the DB-pool drain documented above. The content
service caches `home` and `screen:*` in Redis with 60 s TTL plus
SetNX stampede guard (internal/content/service.go:33-74); services
and zones do not.

Impact:
- Every `/services` and `/zones/check` request takes a DB conn out
  of the pool. At 100 rps that's 6000 DB queries/min on each.
- Failed reads under burst (phase3_geo had `geo 200: passes 30 of
  12000`).

Fix:
- Mirror the content-service pattern: cache services list with
  60-300 s TTL + SetNX stampede lock; invalidate on admin
  upsert/delete (the existing handlers already exist).
- Cache zones check result keyed by lat/lng rounded to ~0.001°
  (~100 m) — zone boundaries are static enough.

Evidence:
- internal/services/service.go:17-19 (no Redis dep)
- internal/zones/service.go:14-28 (no Redis dep)
- internal/content/service.go:33-74 (the pattern to follow)
- phase1.json — services p95 11.6 ms, zones_check p95 6.9 ms at 1
  VU (every miss is a DB hit)
- phase3_geo.json `geo_check_latency.p(95) = 82.74` ms with `geo
  200: passes 30 fails 11970` — geo check effectively went down
  under load.
```

```
[SEVERITY: High]
[FILE: internal/config_manager/service.go:29-56]
[CATEGORY: Performance / Cache stampede]
Finding:
`GetConfig` reads a single Redis key per config lookup. On miss it
falls through to Postgres, writes to Redis with a 5-min TTL. No
SetNX stampede protection — when a config TTL expires under load,
every in-flight request races to read Postgres. `GetMatchingConfig`
and `GetPricingConfig` chain THREE such reads each, multiplying the
stampede factor by 3-5x.

Impact:
- Brief Postgres spike every 5 minutes per popular config key.
- `GetMatchingConfig` runs at the start of every matching attempt
  (engine.go:67-73) and `GetPricingConfig` runs in the booking
  pricing path; a stampede in either correlates with booking
  latency.

Fix:
1. Apply the same SetNX-lock pattern as `internal/content/service.go`.
2. Or, since config values rarely change, do an in-process cache
   layer on top of Redis (sync.Map with 60 s expiry) — saves an RTT
   on every request.

Evidence: internal/config_manager/service.go:31-56.
```

```
[SEVERITY: High]
[FILE: internal/booking/tracking_ws.go:215-228, internal/location/handler.go:220-247]
[CATEGORY: Performance / WebSocket per-connection cost]
Finding:
Customer-side tracking WS pushes every 5 s by calling
`service.GetTracking(ctx, bookingID, userID)` — which is a Postgres
hit for the booking row plus a Redis GeoPos for helper location
(see internal/booking/service.go:642 / 1340 / 1481). With N
concurrent active bookings, that's N DB queries every 5 s plus N
Redis hops. At 1000 concurrent active bookings that is 200 q/s
purely from the tracking layer.

Helper-side WS pushes a `UpdateHelperLocation` (Redis GeoAdd + Set
marker) on every received LocationUpdate (every ~10 s). With 1000
concurrent online helpers that's 100 Redis pipelines/s, plus 100
DB-pool-bound suspension checks at handshake time.

Impact:
- Tracking layer is a multiplier on every other bottleneck.
- No batching; no per-client throttle on the push tick.

Fix:
1. Cache the tracking response per-booking in Redis with a 4-5 s
   TTL; the WS push goroutine reads from cache instead of doing
   DB+Redis fanout per-connection.
2. Switch to Redis pub/sub on `booking:tracking:<id>` — one
   publisher updates state, every subscribed WS gets the message;
   eliminates per-connection polling work entirely.

Evidence:
- internal/booking/tracking_ws.go:215-228 (5 s ticker → DB+Redis)
- internal/booking/service.go:642, 1340, 1481 (the GeoPos calls)
- internal/booking/tracking_ws.go:19 `trackingWSPushInterval = 5 *
  time.Second`
```

```
[SEVERITY: High]
[FILE: internal/booking/service.go (entire), cmd/api/main.go:444]
[CATEGORY: Performance / In-flight write amplification under load]
Finding:
The booking-create path under phase2 (`http_req_duration{cohort:
cust_book}` p95 = 1369 ms, threshold p95<1500 = **false → passing
by 130 ms**) is a single transaction that fans out to: pricing
config (3 Redis reads), promo lookup, wallet debit, slot reservation,
optional Cashfree order create, match enqueue, FCM push, analytics
event insert. Most of those run inline with the request. Status_5xx
count was 50 under 185 VU — non-negligible.

Impact:
- One slow upstream (Cashfree token refresh, or Google Maps) pushes
  the whole path past 1500 ms.
- 50 server-errors per ~4000 booking attempts is ~1.25 % — high
  enough to be the limiting factor on UX at scale.

Fix:
- Move what's safe to async (analytics event insert via outbox;
  match enqueue already routes through batcher).
- Use `singleflight` (golang.org/x/sync/singleflight) around the
  Cashfree token refresh in payments/handler.go:206-251 — a single
  expired token under burst can spawn N concurrent refreshes.
- Already partially mitigated by mw.SafeGo + outbox; complete the
  pattern for the booking-accepted path.

Evidence:
- phase2.json `http_req_duration{cohort:cust_book}.avg = 643.85`,
  `p(95) = 1369.21` ms; status_5xx = 50; status_429 = 1770.
- internal/payments/handler.go:206-251 (token cache, no
  singleflight).
- internal/booking/service.go is 1786 lines and walks all of the
  above per-request.
```

```
[SEVERITY: Medium]
[FILE: internal/crm/refunds/refunds.go:842-849]
[CATEGORY: Performance / Unbounded fire-and-forget goroutine]
Finding:
The customer-refund notification is dispatched via
`go func(ctx context.Context, ...)` with `context.Background()` and
NO timeout (call at line 849: `context.Background(), userID,
amountCents, bookingID`). The FCM call inside
`NotifyCustomerRefundProcessed` will hang for whatever the FCM
client's default timeout is (Firebase Admin SDK does not enforce one
by default). Under FCM degradation, these goroutines pile up.

Impact:
- Goroutine leak during FCM outages.
- The accompanying comment explicitly says "callers should not be
  able to cancel" — fair, but a 30-second timeout would still cancel
  on FCM hang while honouring the fire-and-forget intent.

Fix:
Replace `context.Background()` with
`ctx, cancel := context.WithTimeout(context.Background(),
30*time.Second); defer cancel()`. Update the comment to reflect that
the timeout is a hang-prevention measure, not a request-cancel.

Evidence: internal/crm/refunds/refunds.go:842-849.
```

```
[SEVERITY: Medium]
[FILE: internal/leave/cron.go:33-61, internal/roomies/cron.go:29-61, internal/analytics/rollup_worker.go:35-55, internal/segments/segments.go:73-101, internal/reengagement/worker.go:34-54]
[CATEGORY: Performance / Multi-instance cron safety]
Finding:
Five cron workers run unconditionally on every replica:
- leave.Worker  (1 h tick, idempotent SQL — OK)
- roomies.Worker (1 h tick, auto-settle update — likely idempotent
  but no lease)
- analytics.RollupWorker (1 min tick, REFRESH MATERIALIZED VIEW —
  REFRESH MATERIALIZED VIEW takes a heavy lock; two replicas
  refreshing concurrently is wasted work at best, deadlock-prone at
  worst).
- segments.Worker (24 h tick, big UPDATE — bulk write race if two
  replicas tick within the same hour after startup).
- reengagement.Worker (5 min tick, dedupe via DB row state —
  probably OK but unchecked).

Impact:
- On scale-out: duplicate work, possible deadlocks on materialized
  view refresh, duplicate re-engagement push to a user (if a
  reengagement row state-transition race occurs).
- Wasted DB conns during cron windows; correlated latency spikes.

Fix:
1. Wrap each Start() in `pg_try_advisory_lock(<unique_id>)`; only
   acquire-success replicas proceed.
2. Or run crons via a separate `cmd/worker` binary on a single
   replica.

Evidence: see file paths above. ScheduledDispatcher uses SKIP LOCKED
for booking rows (good); the period-tick workers do not gate the
tick itself.
```

```
[SEVERITY: Medium]
[FILE: internal/notification/service.go:182-253, internal/notification/service.go:357-370]
[CATEGORY: Performance / FCM batch sizing + retries]
Finding:
`sendToTokensWithReport` uses `SendEachForMulticast` which Firebase
caps at 500 tokens per call. The code does not chunk — if a callsite
passes >500 tokens (e.g. admin broadcast in CRM), FCM returns an
error and the entire batch fails. There is also no retry on transient
FCM errors (status 5xx, deadline exceeded); only "unregistered" is
acted on (token prune). Other transient failures are logged warnings.

Impact:
- Large admin pushes silently fail above 500 tokens.
- Transient FCM blips cause notification loss.

Fix:
1. Chunk `tokens` into 500-sized slices inside
   sendToTokensWithReport before calling FCM.
2. Track per-token `r.Error` codes other than IsUnregistered and
   queue retries with backoff (max 3) for `Internal`, `Unavailable`,
   `QuotaExceeded`.

Evidence:
- internal/notification/service.go:210 `s.fcmClient.
  SendEachForMulticast(ctx, &messaging.MulticastMessage{...
  Tokens: tokens})`
- Firebase doc: max 500 recipients per multicast.
```

```
[SEVERITY: Medium]
[FILE: internal/middleware/idempotency.go:60-95]
[CATEGORY: Performance / Idempotency cache size + replay payload]
Finding:
Successful response bodies are stored in Redis (cacheKey, responseTTL).
There is no payload size cap — a 4 MB POST body's response is stored
as-is. The fiber BodyLimit is 4 MB (cmd/api/main.go:187); a malicious
client can fill Redis with 4 MB cached responses keyed by random
Idempotency-Key headers.

Impact:
- Redis memory exhaustion via idempotency cache spam.
- 4 MB × N requests across responseTTL = real money on Railway Redis.

Fix:
1. Skip caching responses larger than e.g. 128 KB; just refuse to
   replay and let the second call redo the work (or 409 it).
2. Validate the Idempotency-Key header shape (UUID v4) to limit the
   key cardinality from a single attacker.

Evidence: internal/middleware/idempotency.go:82.
```

```
[SEVERITY: Medium]
[FILE: cmd/api/main.go:183-200]
[CATEGORY: Performance / Fiber server timeouts]
Finding:
`WriteTimeout: 120s, ReadTimeout: 60s, IdleTimeout: 120s`. The 120 s
WriteTimeout means a wedged client connection holds a goroutine for
two minutes before Fiber GC kicks in. Combined with no `Concurrency`
limit set on `fiber.Config`, a slowloris-style attack can pin
thousands of goroutines.

Impact:
- DoS surface: maintain enough open connections to exhaust
  goroutine memory.
- Slow per-handler timeouts already exist (12 s default + 90 s for
  /zop/chat), but the connection-level timeout is much higher.

Fix:
1. Set `Concurrency: 256 * 1024` (or lower) on fiber.Config so the
   accept-loop has a hard ceiling.
2. Consider trimming WriteTimeout to 30s — 90 s /zop/chat is the
   outlier; everything else completes in <12s.

Evidence: cmd/api/main.go:183-200.
```

```
[SEVERITY: Medium]
[FILE: internal/booking/service.go:642, 1340, 1481]
[CATEGORY: Performance / N+1 Redis GEO lookups]
Finding:
Three independent code paths read helper Redis location one helper
at a time via `s.rdb.GeoPos(ctx, "helpers:locations", *booking.
HelperID)`. In contexts that load multiple bookings (history /
admin / batched tracking), this becomes N round-trips.

Impact:
- N round-trips where 1 pipelined call suffices.
- Multiplies WS-push tracking cost from finding 1.

Fix:
- Where the caller already has a slice of helper IDs, batch via
  `pipe := s.rdb.Pipeline(); for _, id := range ids { pipe.GeoPos
  (...) }` or use `GeoPos(ctx, key, ids...)` which accepts variadic
  members.

Evidence: cited lines.
```

```
[SEVERITY: Medium]
[FILE: internal/content/service.go:166-186]
[CATEGORY: Performance / SCAN in admin path]
Finding:
`InvalidateContentCache` runs `s.rdb.Scan(ctx, 0, "content:screen:*",
100).Iterator()` and walks the cursor on every admin content update.
SCAN against a large keyspace is O(N) over total keys regardless of
match. On a busy Redis, this is a multi-ms cliff.

Impact:
- Slow admin updates; tail latency on rare admin actions.
- Not user-facing today but worth noting.

Fix:
- Maintain a Redis SET `content:screen:keys` that records which
  screen IDs are cached. Invalidate by iterating the SET (O(M),
  where M = active screens).

Evidence: internal/content/service.go:171-178.
```

```
[SEVERITY: Medium]
[FILE: internal/notification/service.go:525-555]
[CATEGORY: Performance / Device-token query unbounded]
Finding:
`deviceTokensFor` returns DISTINCT fcm_token where `updated_at >
now() - interval '90 days'`. For a user with many devices (or a
pro who has signed in on N test devices), the slice is unbounded
and is then passed to SendEachForMulticast which (per the
multicast finding above) caps at 500 tokens.

Impact:
- Pro/user with >500 stale-but-recent tokens silently fails their
  SendData.

Fix:
1. Add `LIMIT 50` to the query — 50 active devices per user is
   already absurd.
2. Add a higher-tier sweeper that nukes device_tokens rows older
   than 30 days (the 90-day window is generous).

Evidence: internal/notification/service.go:535-541.
```

```
[SEVERITY: Medium]
[FILE: internal/matching/dispatch.go:233-273]
[CATEGORY: Performance / General-pool SELECT scans `users` JOIN `helpers`]
Finding:
`generalPool` runs `SELECT u.id FROM users u JOIN helpers h ON h.id
= u.id WHERE u.role IN ('helper','pro') AND ... AND COALESCE
(h.approval_status = 'approved', false) [AND h.locality ILIKE $1]`.
There is no LIMIT before shuffle + cap. Without an index that
serves the WHERE clause, this is a seq scan on every dispatch tick.
The function is also called inside `InviteChain` which holds the
chain alive while shuffling.

Impact:
- Cron-time DB load proportional to total approved helper count
  (small today, larger tomorrow).
- ILIKE on `h.locality` without `text_pattern_ops` or trigram index
  forces a seq scan.

Fix:
1. Add `LIMIT generalPoolCap * 3` to the SELECT and shuffle the
   bounded result.
2. Add a btree index on `(h.approval_status, h.locality)` if not
   present (verify via `SELECT * FROM pg_indexes WHERE tablename
   = 'helpers'`).

Evidence: internal/matching/dispatch.go:233-272.
```

```
[SEVERITY: Low]
[FILE: internal/matching/engine.go:367-417]
[CATEGORY: Performance / FetchPendingUnmatched query]
Finding:
`FetchPendingUnmatched` runs every batcher tick. It includes
`AND created_at > NOW() - INTERVAL '10 minutes'` which is good
(bounded window), and a LIMIT 50. The auto-cancel UPDATE before it
is also bounded. Looks fine.

The minor concern: the UPDATE re-runs every tick (every batch tick)
even when there's nothing to cancel. A `WHERE EXISTS (...)` guard
would short-circuit when the table is clean.

Impact: Negligible. Logged as a noteworthy nit.

Fix: Wrap the UPDATE in a CTE that selects first; skip the UPDATE
when CTE is empty.

Evidence: internal/matching/engine.go:377-386.
```

```
[SEVERITY: Low]
[FILE: internal/zop/service.go:1085-1091]
[CATEGORY: Performance / Zop chat history Redis writes]
Finding:
Each Zop chat turn does a GET → unmarshal → append → marshal → SET
with 24 h TTL, then SAdd to `userSessionsPrefix + userID` and a
separate Expire. That's 4 Redis round-trips per turn, plus one per
turn for chat-history retrieval upstream. At high LLM-chat volume
this adds up.

Impact: Low. Acceptable for the current Zop traffic.

Fix: Pipeline the four writes.

Evidence: internal/zop/service.go:1071-1091.
```

```
[SEVERITY: Low]
[FILE: internal/middleware/safego.go]
[CATEGORY: Performance / SafeGo lacks metrics]
Finding:
`SafeGo` recovers panics but has no goroutine-counter or panic-rate
metric. In production it's impossible to tell how often the recover
path fires.

Impact: Observability gap, not directly a perf bug.

Fix: Add `atomic.Int64` counters for `safego.spawned` and
`safego.panicked` exposed via the runtime metrics endpoint.

Evidence: internal/middleware/safego.go.
```

```
[SEVERITY: Low]
[FILE: internal/booking/tracking_ws.go:215]
[CATEGORY: Performance / Tracking WS 5 s tick is fixed]
Finding:
The tracking WS pushes every 5 s regardless of booking state.
A booking in `pending` or stale states still wakes the server-side
push. Mobile clients can already render stale data for a few seconds
without UX impact.

Impact: Wasted DB + Redis work on inactive bookings.

Fix: Adapt push cadence to state: 5 s during accepted/in_progress,
30 s while pending, stop entirely after completed/cancelled.

Evidence: internal/booking/tracking_ws.go:19, 215.
```

```
[SEVERITY: Low]
[FILE: internal/middleware/admin.go:80-110]
[CATEGORY: Performance / Admin permission cache]
Finding:
Admin permissions cached with 5 min TTL. No SetNX; concurrent admin
requests can all miss-and-fill simultaneously. Tiny in absolute
terms (admin traffic is small) but worth flagging.

Impact: Negligible.

Fix: Same pattern as content service.

Evidence: internal/middleware/admin.go:21, 94.
```

```
[SEVERITY: Nit]
[FILE: internal/middleware/security.go:85-114]
[CATEGORY: Performance / Logging overhead]
Finding:
RequestLogger only logs 4xx/5xx. At 100 rps with a healthy backend
this is ~0 log lines/s; at the phase3_geo failure rate (94.5 %) at
6157 rps this would be ~5800 lines/s, which zerolog can handle but
which adds disk + Railway-log-ingest overhead. The trade-off is
correct (silence on the happy path) but be aware that during
incidents the log volume balloons exactly when it's least
convenient.

Impact: None today; flagged for capacity planning.

Fix: Sample 5xx logs at >1k/s if it ever becomes an operational
issue.

Evidence: internal/middleware/security.go:96-110.
```

```
[SEVERITY: Nit]
[FILE: pkg/database/postgres.go:71-75]
[CATEGORY: Performance / Postgres extension init]
Finding:
On every boot the code attempts `CREATE EXTENSION IF NOT EXISTS
pg_stat_statements`. On Railway prod the app user typically lacks
the privilege, so this logs a warn line every restart. Cosmetic.

Impact: Log noise.

Fix: Skip the call when `cfg.IsProduction()` or behind an env flag.

Evidence: pkg/database/postgres.go:73-75.
```

---

## Cross-reference to prior audits

- `.audit/FINAL_REPORT.md` and `AUDIT_2025_2026-05-03.md` were
  generated before the matching engine grew the InviteChain primitive.
  The Critical multi-instance finding above is **net-new**.
- Audit IDs `D2-2 / NEW-E2-003` (WebSocket read deadlines), `D3-F5`
  (poll interval), `NEW-B1-001` (cron Stop hooks), and `NEW-B1-002`
  (webhooks semaphore) are visible in the source comments and were
  ALL completed correctly. Good.
- `B2-03 chunk 18` (FCM token pruning on unregistered) is wired and
  exercised by tests — not a regression risk.

## QUESTIONS FOR ADITYA

1. **Railway plan / Postgres connection cap** — what's the actual
   connection cap on the production Railway Postgres service? The
   pool defaults to 80; if the plan allows 100, a single replica is
   fine but autoscale will explode. This is the single biggest
   knob to right-size before launch.
2. **Replicas in production** — does the Railway service run a
   single replica today? If yes, the multi-instance cron / chain
   findings are dormant; if you ever scale to 2+, they fire
   immediately.
3. **InviteChain restart resume** — is "we lose in-flight chains on
   restart" acceptable for v1, or should we wire the resume path
   before TestFlight rollout?
4. **Phase3_geo load test** — was the 94.5% failure rate documented
   anywhere as expected (intentional ceiling test) or was it the
   surprise that drove the bound-limiter introduction? Helps decide
   whether to treat it as a passed test or a known regression.
