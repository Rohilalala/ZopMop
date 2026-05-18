# Rate Limiting & Abuse Protection — Subagent 2

Scope: Go/Fiber backend at `App/househelp-api/`. Audited the middleware
stack, the OTP / auth flow, booking creation + cancellation chains, the
sequential pro invite chain, Cashfree PG order + webhook surface, the
wallet topup + referral flow, and helper-side endpoints.

Overall posture is solid relative to prior audits — there is a real
sliding-window Redis limiter (`middleware/ratelimit.go`), an in-process
token-bucket pre-filter, a webhook ConsumeOnceTx primitive, and a
booking-create idempotency middleware. The biggest residual risks are:

1. **The Firebase OTP path (`POST /auth/firebase`) ships zero per-phone
   throttle.** All effort went into the legacy `/auth/send-otp` route
   which is no longer the production SMS-cost surface. The Firebase
   SDK sends the SMS client-side; an attacker can keep paying Firebase
   billing for any victim's number by hammering the verify endpoint.
   Today the only gate is `SensitivePublicRateLimit` (20/min by IP).
2. **`auth/send-otp` per-phone Incr+Expire is non-atomic and fails OPEN
   on the Incr error path.**
3. **No idempotency / replay protection on most state-changing routes
   beyond booking creation** — cancel, accept, reschedule, keep-looking,
   wallet topup, referral apply, helper status toggles. None require an
   `Idempotency-Key`. Some of these have natural DB-level idempotency
   (e.g. accept uses `WHERE helper_id IS NULL`); others (cancel with
   fees, referral apply) do not.
4. **The 25 s sequential invite chain has no per-pro lockout cooldown
   on accept-then-cancel cycles** — a colluding pro could accept,
   immediately cancel, re-enter the pool. Cancellation fee logic exists
   but the abuse signal is not surfaced.
5. **Places autocomplete (`GET /places/autocomplete`) has no per-route
   cap** — only `authLimiter` (100/min/user). Google Places API is
   billed per request; a single authed account can burn ~6 k Places
   calls/hour.
6. **`/auth/firebase` and `/auth/verify-otp` are rate-limited only by IP
   (20/min)** — but a single brute-force script behind a NAT'd ISP, or
   an attacker rotating IPs, can fully drain the failed-attempt counter
   without ever tripping the global limiter.

Prior audits already documented the limiter architecture and the
fail-closed/fail-open posture; the new findings below extend the
attack surface coverage beyond what `AUDIT_2025_2026-05-03.md` and
`security_audit_report.md` covered.

---

## Findings

```
[SEVERITY: High]
[FILE: App/househelp-api/cmd/api/main.go:431-432]
[CATEGORY: Rate Limiting / OTP & SMS abuse]
Finding:
The Firebase authentication route `POST /api/v1/auth/firebase` is mounted
under `authPublicLimiter` (SensitivePublicRateLimit, 20 req/min by IP)
with NO per-phone-number cap. Phone OTP sending in production happens
client-side via Firebase before this endpoint is hit — but Firebase
will keep sending SMSes per the client's request, and `/auth/firebase`
is the only server-side surface that could meter the "verify this
phone" intent. There is no equivalent of the `otp:phone:<phone>`
per-phone Incr counter that `/auth/send-otp` carries
(`internal/auth/handler.go:304-322`).
Impact:
Three concrete abuse paths:
  1. SMS-bombing — an attacker scripting Firebase from the JS SDK can
     have the victim's phone receive an SMS every few seconds; the IP
     limit is on `/auth/firebase` (verify), not on Firebase's
     `sendVerificationCode`, which the client calls directly with the
     app's public Web API key. Firebase has its own per-project
     anti-abuse but it is forgiving by default.
  2. Toll fraud — pumped-traffic numbers (premium-rate or
     international) bill Firebase. The recent rotation of the Google
     Maps key (per CLAUDE memory) shows the project has been bitten
     by key-abuse before; the Firebase Web key is similarly embedded
     in the app and is exposed.
  3. Even on the server-side verify, 20/min/IP is plenty for a single
     attacker to grind brute-force tokens — Firebase ID tokens are
     long but the verifyIdToken Admin call is comparatively expensive.
Fix:
  - Add a server-side per-phone (or per-fid claim) Redis throttle on
    `/auth/firebase`. Extract the phone from the unverified token
    header BEFORE calling `VerifyFirebaseToken` and gate with the
    same SETNX + cooldown pattern used in `auth/service.go:114-125`
    (otp:cooldown:<phone>), with a longer window (e.g. 30/day or
    10/hour) since legitimate use is rare (~1 sign-in/device).
  - Add Firebase App Check (already in the SDK) on the client and
    require its token at `/auth/firebase`; reject unsigned attestations
    in production. This binds the OTP request to a real installed
    app, not a scripted browser.
  - Confirm Firebase project quotas: `identitytoolkit.googleapis.com`
    sendVerificationCode quota is region-specific and should be locked
    to expected DAU.
Evidence:
  - `cmd/api/main.go:431-432`: `authGroup := api.Group("/auth", authPublicLimiter); authHandler.RegisterRoutes(authGroup)` — sole gate is the IP limiter.
  - `internal/auth/handler.go:95-100`: route mounts `Post("/firebase", h.VerifyFirebase)` with no extra middleware.
  - `internal/auth/handler.go:341-360`: `VerifyFirebase` calls `s.service.VerifyFirebaseToken` directly; no per-phone counter.
  - `internal/auth/service.go:114-125`: the cooldown logic exists for legacy `/auth/send-otp` but is not reachable from the Firebase path.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/auth/handler.go:304-322]
[CATEGORY: Rate Limiting / Counter race + fail-open]
Finding:
The per-phone OTP throttle in `SendOTP` is implemented with INCR + Expire
in two separate Redis commands, and the Expire is fired only when
count==1. There are three issues:
  1. If `Incr` succeeds but `Expire` fails (Redis hiccup), the counter
     never expires and that phone is permanently blocked.
  2. If `Incr` itself errors, the whole block is short-circuited and
     the request continues without ANY throttle (fail-OPEN). The handler
     returns `nil` on the error path and falls through to `service.SendOTP`.
  3. There is a TOCTOU between the Incr count check and the actual
     `service.SendOTP` call — two concurrent requests for the same
     phone can both observe count=4 (≤3) and proceed. Not a big deal at
     3/5min but is at higher caps.
Impact:
  - Lost-Expire path: any phone with one observed Incr-Expire pairing
    error during a Redis re-shard becomes locked out for 24 h (Redis'
    default no-TTL key lifetime). Affected users see a hard 429 until
    a human flushes the key.
  - Fail-open path: a Redis outage opens the door to per-phone
    SMS-spam abuse since the underlying `service.SendOTP` cooldown
    SETNX would also have failed (it propagates the error and surfaces
    as 5xx — but the handler-level Incr fails open silently before
    reaching service).
Fix:
  - Replace with the same Lua-script atomic pattern used in
    `middleware/ratelimit.go:310-331` (ZADD + ZREMRANGEBYSCORE +
    EXPIRE in one round-trip), OR collapse to a single `SET key val
    EX <ttl> NX` + separate INCR with a watchdog.
  - When Incr errors, fail CLOSED per the existing `fail-closed`
    convention for sensitive endpoints (this is more sensitive than
    most because each "allow" mints an SMS).
  - The lookup at `service.SendOTP` already uses SETNX with a cooldown
    — the handler-level Incr is partially redundant, but it serves the
    cumulative "3 per 5 min" cap. Consider replacing with a single
    Lua-atomic counter keyed `otp:phone:<phone>` that combines the
    cooldown and the count.
Evidence:
  - `internal/auth/handler.go:304-322`:
    ```
    count, incrErr := h.rdb.Incr(ctx, key).Result()
    if incrErr == nil {
        if count == 1 { _ = h.rdb.Expire(ctx, key, otpWindow).Err() }
        if count > otpMaxPerWindow { return 429 }
    }
    ```
    Note `incrErr != nil` falls through to `service.SendOTP` silently.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/middleware/admin_auth.go:43-67]
[CATEGORY: Rate Limiting / Counter race]
Finding:
The SDUI admin rate limiter (`SduiAdminAuth`) uses the same Incr-then-
Expire pattern as the OTP throttle. The Expire is fired only when
count==1, and the Expire error is ignored. On Redis Incr error the
limiter fails OPEN (`c.Next()` after logging warn). The key includes
the minute epoch (`sdui:admin:rl:<user>:<minute>`) so a lost Expire is
less harmful than the OTP case — the key is naturally rotated each
minute and will eventually expire via Redis maxmemory eviction. Still,
high-cardinality minute keys with no TTL pile up in Redis if Expire
keeps failing.
Impact:
  - Memory bloat in Redis if Expire is consistently lossy.
  - Fail-open posture for an admin-touching endpoint is questionable;
    admin actions should be fail-closed.
Fix:
  - Switch to the Lua-script sliding-window primitive in
    `ratelimit.go`; the same `NamedRateLimiter("crmAdmin", ...)`
    pattern already exists and is in use for the crmAdmin limiter
    (`crm/middleware`). Reuse it.
  - At minimum, set TTL on the key whether or not count==1 (idempotent
    Expire is cheap).
Evidence:
  - `internal/middleware/admin_auth.go:49-56`:
    ```
    count, err := rdb.Incr(ctx, key).Result()
    if err != nil { log.Warn... ; return c.Next() }  // fail-open
    if count == 1 { _ = rdb.Expire(ctx, key, 65*time.Second).Err() }
    ```
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/zop/service.go:802-813]
[CATEGORY: Rate Limiting / Counter race]
Finding:
`ZopRateLimiter` (30 msg/hour/user) has the same Incr-then-Expire race
+ fail-open behaviour. Worse: the Expire error is silently dropped
(no log), so an Expire failure produces a permanently stuck counter
that 429s the user until a human flushes Redis. The fail-open path
matters more here because each Zop turn fans out to OpenRouter
(Llama+Gemma) and counts against a paid budget.
Impact:
  - Permanent lockout for a user whose first Expire happened to fail.
  - Fail-open on Incr error means an attacker who can briefly knock
    Redis can bypass the per-hour cap and rack up OpenRouter spend.
Fix:
  - Same fix as above: Lua-atomic INCR+EXPIRE or migrate to the
    existing `NamedRateLimiter` middleware with a "zop" bucket.
  - The `s.checkToolFreq` helper at lines 770-797 has the same bug —
    fix together. Note it does log the Expire failure (good) but still
    races.
Evidence:
  - `internal/zop/service.go:802-813`: same Incr/Expire pattern as
    admin_auth and OTP handler.
  - `internal/zop/service.go:777-797`: tool freq counter, same pattern.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/cmd/api/main.go:445-447]
[CATEGORY: Rate Limiting / Idempotency coverage]
Finding:
Idempotency middleware (`mw.Idempotency`) is applied ONLY to the
booking-creation POST routes (POST /bookings and POST /bookings/scheduled).
Every other state-changing route under `/api/v1/bookings` —
`/cancel`, `/reschedule`, `/keep-looking`, `/accept`, `/arrived`,
`/start`, `/complete`, `/messages` — receives no idempotency
treatment. Same for the entire `/wallet/topup`, `/payments/cashfree/order`,
`/referrals/apply`, `/helpers/me/status`, `/me/onboard-pro` surface.
Impact:
  - `POST /bookings/:id/cancel`: cancellation may charge a fee
    (`internal/booking/cancellation.go:6-15`); a retried cancel after
    a network hiccup could double-debit the wallet. The repo guard
    `WHERE status IN (...)` makes a second cancel into a 4xx, but
    the FIRST attempt's response may have been lost — the client
    cannot safely retry.
  - `POST /referrals/apply`: relies on `HasReferral` + INSERT in a tx
    (`internal/referral/service.go:134-152`). A retried apply with
    racing concurrent requests could pass the read and double-insert
    if the unique index is missing or weak. Inspected
    `repository.go.CreateReferralTx` would be the source of truth.
  - `POST /wallet/topup`: delegates to Cashfree order creation. The
    `payments.findReusableCashfreeOrder` lookup at
    `internal/payments/handler.go:441-444` IS keyed on bookingID for
    booking topups, but the wallet-topup path has no idempotency
    short-circuit at all — two retries create two pending payments
    rows.
Fix:
  - Mount `mw.Idempotency` on the full `/bookings`, `/wallet`,
    `/payments`, and `/referrals` groups (not just POST /). The
    middleware is no-op for requests without `Idempotency-Key`.
  - For `/payments/cashfree/order` with `payment_source=wallet_topup`,
    add a server-side natural-key dedupe (e.g. one pending wallet
    topup per user) to short-circuit retries.
  - Document the `Idempotency-Key` requirement for the mobile app and
    add it to the booking-cancel + wallet-topup client paths.
Evidence:
  - `cmd/api/main.go:445-447`: `bookingIdem := mw.Idempotency(...)` is
    appended only to `Post("/", ...)` and `Post("/scheduled", ...)` in
    `booking.Handler.RegisterRoutes` (`internal/booking/handler.go:52-60`).
  - `internal/booking/handler.go:69-72`: cancel/accept/start/complete
    mounted directly with no idem chain.
  - `internal/payments/handler.go:464-484`: wallet topup path creates
    a fresh payments row every call without dedupe.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/matching/dispatch.go:42-53]
[CATEGORY: Rate Limiting / Abuse — invite chain]
Finding:
The sequential pro invite chain (`InviteChain`) holds each pro in a
25 s window (`perProInviteWait = 25*time.Second`) and the global cap
is 30 min (`chainHardCap`). Acceptance is atomic at the DB layer
(`AcceptBooking` uses `WHERE helper_id IS NULL`). However:
  - No per-pro cooldown after a refused / timed-out invite. A pro
    that auto-declines via `DeclineInvite` (POST
    `/helpers/me/invites/:bookingId/decline`) can be re-invited by
    the next chain iteration with no delay. Cheap signal, but it
    means a colluding pro can grief a customer by being the first
    invited candidate, declining quickly, and re-entering the pool
    via phase 2 (general pool is shuffled, no exclude-list of
    decliners).
  - Accept-then-cancel abuse: a pro can `AcceptBooking`, get the
    customer's identity (booking detail), then cancel. The
    `cancellation.go` fee logic exists but I see no per-pro abuse
    counter — repeated accept-cancel cycles within a short window
    aren't tracked. The pro's `total_jobs` and rating may shift
    over many cycles.
  - Parallel-flood: the chain is per-booking. A pro can be in
    multiple chains simultaneously (max active limit checks happen
    on accept, not invite). Their invite set in Redis
    (`match:h:<helper>`) can grow up to 100 (`maxInvites` cap at
    `engine.go:105`), but the dispatcher itself doesn't dedupe.
Impact:
  - Customer experience: a malicious pro who chronically declines
    can sit at the head of the invite list for popular customers.
  - Fraud: accept-then-cancel after seeing customer name/address
    is a known abuse vector in delivery apps; ZopMop has the same
    surface.
Fix:
  - After a decline OR a 25s-timeout, write a 5-minute SETEX
    `pro:decline_cooldown:<helperID>:<bookingID>` and exclude the
    pro from subsequent runs of `runOne` for that booking.
  - After a cancel-by-pro within N minutes of accept, increment
    `pro:accept_cancel:<helperID>` with a daily window; auto-suspend
    is_available when count > 3.
  - Audit `helper_id` change history per booking — currently no
    booking-state-history audit table is visible.
Evidence:
  - `internal/matching/dispatch.go:42-53`: perProInviteWait + chainHardCap.
  - `internal/matching/dispatch.go:381-454`: `InviteChain` walks tried[]
    but a same-booking decliner is NOT added to a persistent block
    list — only the in-memory `tried` map for this chain run.
  - `internal/matching/engine.go:99-115`: GetHelperInvites caps to 100.
  - `internal/booking/repository.go:319-329`: AcceptBooking is atomic;
    no concurrent accept by same pro is possible, but no abuse counter.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/places/handler.go:24-41]
[CATEGORY: Rate Limiting / Cost amplification]
Finding:
`GET /api/v1/places/autocomplete?q=...` is gated only by
`authMiddleware` + `authLimiter` (100 req/min/user). Google Places API
is billed per request (~$0.0028 / autocomplete-session call). At
100/min/user across an authenticated bot army this is ~$16 per user
per day in API cost. The handler itself does no caching — every call
goes to Google.
Impact:
  - Direct $$ burn from any account-creating attacker.
  - Quota exhaustion: hitting the daily Places quota disables
    address-picking for legitimate users.
  - The Google Maps key is also used for Distance Matrix in matching;
    a Places-quota burn could spill over.
Fix:
  - Add a tighter per-user named limiter for this route (e.g. 30/min
    or 1000/day) via `NamedRateLimiter(rdb, ..., "user", "places")`.
  - Add a Redis-backed cache keyed on `places:ac:<sha1(q)>` with 1h
    TTL — Places sessions are stable for autocomplete-session-token
    use; repeated identical prefixes are common.
  - Confirm Google Cloud key restrictions: the Places key should be
    HTTP-referrer-locked for web and bundle-locked for iOS/Android;
    the proxy server itself should use a SEPARATE key with API
    restriction = Places API only.
Evidence:
  - `cmd/api/main.go:505-508`: only `authMiddleware` + `authLimiter`.
  - `internal/places/handler.go:24-41`: no cache layer, direct
    pass-through to `mapsClient.PlacesAutocomplete`.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/booking/service.go:343-383]
[CATEGORY: Rate Limiting / Booking spam]
Finding:
`CreateBooking` is gated by FOUR independent layers — `BookingCreateRateLimit`
(3/min/user), `AuthRateLimit` (100/min/user), the
`ConfigBookingMaxActivePerCustomer` config (default 1 active),
and the `fn_bookings_reject_dup_within_hour` PG trigger (2-minute
dedup on pending status). This is good. BUT:
  - The `BookingCreateRateLimit` is `FailureMode: "local-fallback"`
    (`middleware/ratelimit.go:56`) — on Redis outage, the local
    in-memory token bucket takes over per process. With multiple
    API instances behind Railway's load balancer, the effective
    cap multiplies by replica count, so an attacker who knows the
    replica count and IP-hashing can burst ~3 × N bookings in a
    minute before any of them serialize through Postgres.
  - The 2-minute trigger window is for SAME `service_category_id`
    only. A customer can spam different categories with no DB-side
    block; the rate limiter at 3/min is the only stop.
  - `GetActiveBookingsCount` query is best-effort — under tight
    races (two parallel creates within ms) both can observe
    activeCount=0 and pass. The DB trigger only catches
    same-category dups, not different-category overruns of the
    max-active cap.
Impact:
  - On Redis outage, a single user can create up to 3 × N bookings
    in a minute (N = api replicas) before the DB max-active check
    serializes them. The DB then enforces max-active=1 via
    `GetActiveBookingsCount` but that's a non-atomic check; under
    parallel inserts it can be bypassed.
Fix:
  - Promote max-active enforcement to a partial unique index on
    `bookings(customer_id) WHERE status IN ('pending','accepted',
    'in_progress')` for any config value of 1 (most common). For >1
    we need a different approach. This makes the check atomic.
  - Consider tightening `BookingCreateRateLimit` to `fail-closed`
    given the cheap local-fallback bypass. The cost of a rejected
    legit booking during a Redis outage is small (user retries);
    the cost of an unbounded create flood is large (matching
    storm + DB writes + notifications).
Evidence:
  - `internal/middleware/ratelimit.go:50-56`: BookingCreateRateLimit
    spec.
  - `internal/booking/service.go:364-370`: GetActiveBookingsCount
    check is sequential, not transactional.
  - `migrations/062_bookings_dedup_relax.up.sql:14-30`: trigger only
    blocks same-category pendings within 2 minutes.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/payments/handler.go:436-454]
[CATEGORY: Rate Limiting / Idempotency on order create]
Finding:
`createCashfreeOrderForBooking` has a defensive idempotency layer
(`findReusableCashfreeOrder` reuses pending+unexpired Cashfree orders
for the same bookingID) but this only fires for the BOOKING path. The
`wallet_topup` path (createCashfreeOrderForWalletTopup, lines 464-484)
has no equivalent dedupe — every retry creates a new payments row +
new Cashfree order. Resulting db rows are harmless (gateway_status='pending')
but each call also burns a Cashfree create-order API call and clutters
the cashfree_orders table. The 4 MB body limit + the 15 s gateway
timeout mean retries from the mobile app on flaky networks are common.
Impact:
  - Cashfree-side rate limit / spend.
  - DB clutter; if the user racks up many failed topups the
    cashfree_orders table grows.
Fix:
  - Add a `findReusableWalletTopup(ctx, userID, amountPaise)` similar
    to the booking version — query for the latest pending payments
    row of `kind='topup'` for this user with the same amount inside
    the last (e.g.) 10 minutes.
  - Better: require `Idempotency-Key` for /wallet/topup once the
    middleware is wired on /wallet (see Idempotency coverage finding).
Evidence:
  - `internal/payments/handler.go:486-515`: findReusableCashfreeOrder
    keyed on booking_id, not user_id/amount.
  - `internal/payments/handler.go:464-484`: wallet-topup path has no
    reuse lookup.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/helper/handler.go:122-139]
[CATEGORY: Rate Limiting / Helper location floods]
Finding:
`PUT /helpers/me/location` is the high-frequency pro-side endpoint
(called on a timer to keep the matching engine's view fresh per
the comment). Sole gating is `authMiddleware` + `authLimiter`
(100/min/user). The pro client is implementation-trusted to throttle
itself. A malicious / buggy pro client can hammer this at 100/min
indefinitely, writing to `helpers.location` (PostGIS) + a Redis
GEOADD per call.
Impact:
  - Hot row on `helpers` for that pro, causing pgxpool contention.
  - Redis GEOADD churn on `helpers:locations`.
  - The matching engine's KNN may flap as the pro's coord jumps
    around quickly.
Fix:
  - Add a NamedRateLimiter at e.g. 10/min for this route (one ping
    every 6 s is plenty — the existing pollInterval is 5 s on the
    accept side).
  - Better: server-side debounce in service.UpdateLocation — drop
    writes when the new coord is within 5 m of the last one for
    that helper, kept in Redis.
Evidence:
  - `cmd/api/main.go:590`: `helpersGroup` chain.
  - `internal/helper/handler.go:50`: `approved.Put("/me/location", ...)`
    no per-route limiter.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/booking/handler.go:67-68]
[CATEGORY: Rate Limiting / Chat message floods]
Finding:
`POST /api/v1/bookings/:id/messages` (booking chat) has no per-route
rate limit — only the authLimiter (100/min/user). For an in-flight
booking this is a flood vector: 100 messages/minute / per direction,
on a long-running booking (up to ~hours), means thousands of rows in
`booking_messages` for one booking. Combined with the SendMessage
notification path (each message fires an FCM), this is also a
notification-spam vector for the counterparty.
Impact:
  - DB bloat on `booking_messages`.
  - FCM cost + counterparty notification spam.
Fix:
  - Add a NamedRateLimiter at 10/min/user (one message per 6 s is
    plenty for human typing) on `POST /bookings/:id/messages`.
  - Soft-debounce FCM: only one FCM per (booking_id, sender) per
    60 s; the in-app screen polls anyway.
Evidence:
  - `internal/booking/handler.go:67`: `router.Post("/:id/messages", h.SendMessage)`
  - No limiter chain. Per-booking caps not implemented.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/middleware/ratelimit.go:73-114]
[CATEGORY: Rate Limiting / Local fallback memory pressure]
Finding:
The in-process token-bucket pre-filter caps `localBuckets` at 50 000
entries with a bounded sweep of 2 000 / insert. On a sustained
high-cardinality flood (e.g. botnet rotating IPs), the bounded sweep
can lag behind the insert rate: every flood IP creates a bucket, the
sweep only reaps 2 k per new bucket creation, and a sustained 5 k+
unique-IP/sec flood overruns it. The map grows past 50 k unboundedly
since once `len > 50000` the sweep just deletes COLD entries; if
new traffic keeps inserting "hot" buckets, the cap isn't enforced.
Impact:
  - Memory creep during a distributed flood — by design the map can
    grow because the cap check only triggers sweeping, not eviction.
  - Each bucket is ~64 B per the comment; 1M entries = ~64 MB.
    Survivable but worth a hard cap.
Fix:
  - When `len(localBuckets) > 100000`, switch to random eviction
    (delete a fixed number of random keys per insert) so the cap
    is hard, not soft.
  - Alternatively, use `golang.org/x/sync/singleflight` plus a true
    LRU like `hashicorp/golang-lru`.
Evidence:
  - `internal/middleware/ratelimit.go:119-156`: the comment promises
    "bounded sweep" but does not enforce a hard ceiling.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/middleware/idempotency.go:47-64]
[CATEGORY: Rate Limiting / Idempotency replay surface]
Finding:
`Idempotency` is keyed by `idem:<userID>:<key>` and gates POST creates.
Two soft issues:
  1. The middleware silently `c.Next()` for unauthenticated requests
     OR when the user provides no `Idempotency-Key` (lines 49-56).
     The route for `POST /bookings` is auth-gated so userID is
     present, but a client that omits the header gets no replay
     protection — and there's no enforcement that booking-create
     requests carry the header. A retry from the mobile app on
     flaky network without the header creates duplicate bookings
     (then blocked by the 2-min PG trigger only if same category).
  2. Redis failure during the SETNX acquire is fail-OPEN
     (`return c.Next()`). The comment at line 36 explicitly says
     this intentionally reverses the prior fail-closed policy,
     but during a Redis outage we lose both the limiter AND the
     idem layer simultaneously — the only remaining safety net is
     the DB trigger.
Impact:
  - During a Redis outage, every retry creates a duplicate
    booking unless category dedup catches it.
  - Clients that don't send the header (silently) are unprotected.
Fix:
  - For state-changing routes flagged as "must be idempotent"
    (booking-create, wallet-topup), REQUIRE the header in the
    handler (`if c.Get("Idempotency-Key") == "" { return 400 }`)
    and document the requirement in the API contract.
  - For Redis-failure fail-open: at minimum, log at WRN and add a
    counter so we can alert on prolonged outages.
Evidence:
  - `internal/middleware/idempotency.go:47-93`.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/insights/service.go:48-65]
[CATEGORY: Rate Limiting / Public endpoint cost]
Finding:
`GET /api/v1/insights/nearby` (used by the home pill) is mounted under
`publicLimiter` (30/min/IP) — generous. Each call performs:
  - Redis GEOSEARCH on `helpers:locations`
  - Up to 50 Redis EXISTS calls (pipelined → 1 RTT)
  - 1 Postgres query for `FilterAvailableHelpers`
  - 1 Postgres query for `AvgRatingForHelpers`
At 30/min/IP × N anonymous IPs, this hits PG hard. The pill polls every
5 s from the mobile app (per the comment at line 67-70) — so a single
legitimate phone is 12/min already. There is no result caching.
Impact:
  - Cheap DDoS surface that pushes load to Postgres + PostGIS.
  - The home pill is a marketing surface; serving a stale 60-s-old
    snapshot is fine.
Fix:
  - Add a 30-60 s cache keyed on (round(lat,2), round(lng,2)) in
    Redis. ~1.1 km cell, plenty granular for "N pros nearby".
  - Tighten the publicLimiter for this route to 10/min/IP, or add
    a NamedRateLimiter at 60/min/IP (matches the 5 s poll exactly).
Evidence:
  - `internal/insights/service.go:48-144`: every call hits Redis +
    PG; no cache.
  - `cmd/api/main.go:545-546`: only publicLimiter + dbBoundLimiter.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/auth/service.go:186-203]
[CATEGORY: Rate Limiting / OTP brute force on verify]
Finding:
`VerifyOTP` enforces 5 failed attempts → 15 min lock per phone
(`maxFailedAttempts`, `otpLockDuration`). Counter is keyed
`otp:fail:<phone>`. Brute-force protection is on the PHONE, not on
the IP — so an attacker who knows a target phone has at most 5
guesses every 15 min. OK. But the legacy `/auth/verify-otp` is
ALSO protected only by `SensitivePublicRateLimit` (20/min/IP) and
`Firebase` path has no equivalent. The 5-attempts lock is reset
on a successful SendOTP via `s.rdb.Del(failKey)` (line 148-150)
— an attacker who can also trigger SendOTP can keep extending
their brute-force budget.
Impact:
  - With a 1 in 1,000,000 (6-digit OTP) chance per guess and 5
    guesses per SendOTP cycle, the attacker who can spam SendOTPs
    can plausibly brute force a target OTP within ~3 days. The
    cooldown (60 s between sends) caps this at 60 × 24 / 5 = 288
    SendOTP cycles per day = 1 440 guesses/day — non-negligible.
Fix:
  - Make `fail:<phone>` and `lock:<phone>` survive SendOTP cycles
    (only reset on successful verify). Comment at line 147-150 says
    "reset OTP failure counter" — but doing so re-arms the
    brute-forcer.
  - Add a long-window counter (e.g. 100 failures / 24 h) that
    triggers a manual-review state, not just a 15 min lock.
Evidence:
  - `internal/auth/service.go:147-150`: failKey deletion on SendOTP.
  - `internal/auth/service.go:186-203`: 5/15min lock on verify.
```

---

## Cross-references to prior audits

- `AUDIT_2025_2026-05-03.md:220-222, 277-281`: confirms the limiter
  architecture (sliding-window + local fallback + fail-mode config)
  was already DONE. New findings here are about coverage gaps and
  Incr+Expire race bugs that prior audits didn't enumerate.
- `AUDIT_2025_2026-05-03.md:450`: prior audit flagged "Idempotency key
  not wired everywhere" as P2 — this finding remains outstanding
  (see Idempotency coverage finding above).
- `security_audit_report.md`: did not enumerate per-endpoint rate
  limiting; the OTP / SMS findings here are new.

## Summary

15 findings: 1 High, 9 Medium, 5 Low.
Path: `/Users/adityarohilla/Documents/ZopMop/audit/findings/rate-limiting.md`

The biggest single risk is the Firebase OTP route's missing per-phone
throttle — that's High. The second cluster is the recurring Incr+Expire
race pattern across OTP, admin SDUI, and Zop — Medium each, identical
fix (Lua-atomic counter or migration to the existing NamedRateLimiter
primitive). The third cluster is Idempotency-Key coverage outside of
booking creation — Medium. Everything else is Low-severity coverage /
cost tightening (Places autocomplete, helper location floods, chat
message floods, home-pill cache).

## QUESTIONS FOR ADITYA

- The Firebase Web/JS API key is what the customer app uses to call
  `sendVerificationCode` — is App Check enabled in the Firebase
  console? If yes, the per-phone server throttle for `/auth/firebase`
  is less urgent (but still wanted). If no, that's the highest-leverage
  fix.
- The Cashfree webhook replay window is ±300 s. Is that explicitly
  permitted by Cashfree, or should we tighten to ±60 s? Cashfree's
  docs are conservative on retries — a tighter window reduces a
  signature-replay risk for a leaked webhook secret.
- Are there plans to wire `Idempotency-Key` into the mobile app's
  retry layer? If yes, the route-level enforcement (required header)
  becomes safe to add. If no, we should at least add the middleware
  to all state-changing routes so explicit retries from server-to-server
  callers can use it.
- For the invite-chain abuse counter (accept-then-cancel by pros): is
  there an existing "fraud signal" surface in CRM that I should hook
  into rather than building a new Redis counter?
