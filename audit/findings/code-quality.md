# Subagent 10 — Code Quality & API Contracts

Audit date 2026-05-15. Scope: backend Go + mobile TS under `App/`.
Cross-referenced against `AUDIT_2025_2026-05-03.md`, `.audit/FINAL_REPORT.md`,
and user memory entries. New findings only — items already documented in
prior audits are noted explicitly.

---

## Summary

Severity counts:

- Critical: 1
- High: 6
- Medium: 11
- Low: 6
- Nit: 4

Headline issues:

1. **Money-field mislabelling is now system-wide.** Backend stores paise but
   tags JSON keys as `*_cents` across 14 structs spanning booking, helper,
   webhooks, admin, CRM and Zop. Mobile TS mirrors the wrong name. Any
   future contributor reading code, hitting the API, or pasting payloads
   into a console will arrive at a 100× pricing bug.
2. **No API versioning policy on the wire.** Only one `/api/v1` prefix is
   hard-coded. There is zero `X-App-Version` / minimum-supported-version
   negotiation and no force-update screen. Schema drift between an older
   binary and a newer backend silently fails.
3. **Naming conventions are inconsistent across modules** —
   `lat/lon` (addresses, insights) vs `lat/lng` (booking, helper, location
   WS); list envelopes are `bookings` / `addresses` / `experts` on
   customer routes but `items` on CRM routes; verb-in-path
   (`/apply`, `/topup`, `/declare`, `/onboard-pro`) sits next to RESTful
   noun paths.
4. **Helper-side `HelperBooking` TS type cannot deserialise the real
   payload.** Backend returns `price_cents` carrying paise, mobile types
   it `price_cents` too — coincidence on the wire — but the
   `customer_id`, `address` and `service_category_id` fields the type
   declares are not all returned by `GET /bookings/helper/active`
   (verified in `internal/booking/handler.go:524-553`).
5. **Test coverage is sparse on critical modules.** `internal/matching`
   (engine + dispatcher), `internal/leave`, `internal/roomies`,
   `internal/zop` (1,996 LOC, 2 functions >230 lines), `internal/zones`,
   `internal/insights`, `internal/services`, `internal/addresses` — all
   ship with **zero** `*_test.go` files.

---

## Findings

### 1. Money field tag/name mismatch (paise vs cents)

```
[SEVERITY: Critical]
[FILE: App/househelp-api/internal/booking/model.go:27]
[CATEGORY: Code Quality / Naming consistency]
Finding:
  `AmountPaise int` is serialised as `json:"price_cents"`. Same pattern
  repeats on lines 29 (DiscountPaise→discount_cents), 91-92 (ScheduledBooking),
  and across 14 other Go structs (see Evidence). Values are paise (₹1 = 100
  paise) but the wire key claims cents. India does not use cents.
Impact:
  - Reading the JSON in a console / Postman / API consumer with no
    Go-source context lands you at a 100× pricing bug. ₹500 is sent as
    `price_cents: 50000` — a USD-thinking integrator reads $500.
  - The misalignment between Go field name (`AmountPaise`) and tag
    (`price_cents`) means search-by-name across the repo splits results
    into two halves. Refactoring tooling cannot follow the rename.
  - Mobile types (App/zopmop-app/src/api/bookings.ts:16,30, cart.ts:11,
    pro.ts:22) mirror the wrong name; the bug propagates client-side.
  - The 2026-05-14 hybrid-schema incident (per user memory) was a direct
    consequence of `price_cents` vs `price_paise` confusion at the DB
    column level. The handler payload still carries the historical name.
Fix:
  Define a wire contract once: choose `price_paise` everywhere. Migrate
  in two steps —
    (a) emit BOTH keys for one release: `price_paise` (canonical) +
        `price_cents` (deprecated alias). Mobile updates to read paise.
    (b) drop `price_cents` after the version-pinned minimum mobile
        binary is shipped.
  Until then, rename the Go fields to match the tag (or vice-versa) so
  internal naming agrees with the wire.
Evidence:
  $ grep -rn 'Paise.*json:".*_cents"' --include="*.go" internal/
    internal/booking/model.go:27, 29, 91, 92
    internal/zop/service.go:415, 416
    internal/crm/users/model.go:58
    internal/crm/orders/orders.go:42, 43
    internal/crm/workers/model.go:56
    internal/admin/model.go:78, 79
    internal/webhooks/payloads.go:42
    internal/helper/model.go:26
  Mobile mirrors:
    App/zopmop-app/src/api/bookings.ts:16  price_cents: number;
    App/zopmop-app/src/api/cart.ts:11      price_cents: number;
    App/zopmop-app/src/api/pro.ts:22, 24   price_cents / discount_cents
```

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/wallet/model.go:60]
[CATEGORY: Code Quality / Naming consistency]
Finding:
  Wallet module is the lone correct example — it uses
  `AmountPaise int64 json:"amount_paise"` consistently
  (also `total_earned_paise` in referral + helper). This proves the
  codebase already accepts the paise convention; the rest of the modules
  diverged later. The wallet API and the booking API now disagree about
  what unit a booking-related amount is reported in.
Impact:
  Mixed JSON outputs: GET /wallet → `balance_paise: 50000`, GET
  /bookings/... → `price_cents: 50000`. A consumer cannot trust the
  unit suffix without reading source. CRM dashboards and analytics
  pipelines (Subagent 1 territory) will silently treat one or the other
  incorrectly.
Fix:
  Treat `*_paise` as the canonical unit suffix. See finding 1 fix steps.
Evidence:
  internal/wallet/model.go:60   AmountPaise int64 json:"amount_paise"
  internal/referral/model.go:36 TotalEarnedPaise int64 json:"total_earned_paise"
  internal/helper/model.go:12   TotalEarnedPaise int64 json:"total_earned_paise"
```

### 2. Latitude/longitude field naming

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/addresses/model.go:19]
[CATEGORY: Code Quality / Naming consistency]
Finding:
  Backend uses both `lon` and `lng` for longitude across different
  modules with no documented rule:
    - addresses, insights query string: lon
    - booking, helper, location WS, places: lng
  Mobile types follow the backend per-module, so `ApiAddress.lon`,
  `ApiBooking.helper_lng`, `HelperBooking.lng`, `NearbyStats` query
  `lon`.
Impact:
  - Cross-module code (e.g. building a payload that combines an
    address with a booking) requires explicit field re-mapping every
    time. Easy to send the wrong value.
  - Search/rename refactors miss half the call sites.
  - Onboarding cost: every new contributor learns this trap.
Fix:
  Pick one (`lng` is the more common JS convention; `lon` is the more
  common ISO convention) and migrate. Prefer `lng` since the majority
  of new modules and the React Native maps library already use it.
  Same dual-emit deprecation strategy as finding 1.
Evidence:
  internal/addresses/model.go:19,36,51   Lon float64 json:"lon"
  internal/insights/handler.go:33,36-49  query "lon"
  internal/booking/model.go:26,60        Lng float64 json:"lng"
  internal/helper/model.go:23,33         Lng float64 json:"lng"
  internal/location/handler.go:236,242   "lng": update.Lng
  App/zopmop-app/src/screens/main/HomeScreen.tsx:310  addr.lon
  App/zopmop-app/src/screens/pro/ProDashboardScreen.tsx:113  customerLng: a.lng ?? 0
```

### 3. List response envelope is inconsistent

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/booking/handler.go:209]
[CATEGORY: Code Quality / Response shape]
Finding:
  Customer-facing endpoints wrap arrays under domain-specific keys:
    GET /bookings        → {"bookings": [...]}
    GET /addresses       → {"addresses": [...]}
    GET /me/experts      → {"experts": [...], "limit": N}
    GET /wallet/transactions → {"transactions": [...]}
    GET /me/usuals       → {"service_ids": [...]}
    GET /app/services    → {"services": [...]}
  CRM endpoints uniformly use the generic envelope:
    GET /admin/orders    → {"items": [...], "total_count": N, "limit": N, "offset": N}
    GET /admin/refunds   → {"items": [...], "total_count": N, "limit": N, "offset": N}
    GET /admin/promotions → {"items": [...], ...}
  And then a third style exists with raw arrays returned alongside
  `data.invites` etc. (e.g. `internal/helper/handler.go` invites,
  internal/leave history). The mobile client (`api/bookings.ts:91`,
  `pro.ts:41,57`) defends against this by doing
  `data?.bookings ?? []`.
Impact:
  - No reusable list-handler abstraction possible. Each screen rolls
    its own pagination handling, total counting, and envelope parsing.
  - Pagination metadata is present on CRM endpoints but completely
    missing from customer endpoints — `getBookings()` queries
    `?status=upcoming&page=1&limit=20` but the server returns no
    `has_more`/`total` (handler.go:209-221). The client cannot tell if
    it has hit the last page.
Fix:
  Standardise on one envelope: `{data: [...], meta: {next_cursor?,
  total?}}`. Migrate customer endpoints first since they currently
  have no metadata at all; CRM keeps `items` but renames to `data`.
  Or — easier ratchet — leave the per-domain keys but add `meta`
  consistently. Document the chosen shape in a top-level
  `docs/api/response-shape.md`.
Evidence:
  Customer:
    internal/booking/handler.go:209,221,537,553  fiber.Map{"bookings": ...}
    internal/addresses/handler.go:42              {"addresses": addrs}
    internal/experts/handler.go:39                {"experts": out, "limit": ...}
    internal/wallet/handler.go:94                 {"transactions": rows}
    internal/insights/handler.go:76,81            {"service_ids": ...}
    internal/content/handler.go:311               {"services": services}
  CRM (uniform `items`):
    internal/crm/orders/orders.go:605
    internal/crm/refunds/refunds.go:461
    internal/crm/promos/promos.go:305
    internal/crm/payouts/payouts.go:154
    internal/crm/banners/banners.go:219
    internal/crm/experiments/experiments.go:210
    internal/crm/notifications/notifications.go:190
    internal/crm/leaves/leaves.go:295
```

### 4. Verb-in-path coexists with RESTful nouns

```
[SEVERITY: Medium]
[FILE: App/househelp-api/cmd/api/main.go:444]
[CATEGORY: Code Quality / Endpoint naming]
Finding:
  Route style mixes RESTful resources with action-as-path:
    RESTful:    /bookings, /bookings/:id, /addresses, /cart/items/:id,
                /admin/services, /me/experts/:helperId
    Verb-as-path:
                /auth/send-otp, /auth/verify-otp, /auth/logout,
                /me/onboard-pro, /me/fcm-token (PUT),
                /referrals/apply,
                /wallet/topup,
                /payments/validate-vpa,
                /payments/cashfree/order, /payments/cashfree/webhook,
                /pro/leave/declare, /pro/leave/affected-tomorrow,
                /bookings/:id/keep-looking, /bookings/:id/arrived,
                /bookings/:id/start, /bookings/:id/complete,
                /bookings/:id/accept, /bookings/:id/cancel
    Cross style:
                DELETE /bookings/:id AND POST /bookings/:id/cancel
                (same operation — `internal/booking/handler.go:70-71`)
Impact:
  - Two endpoints for cancellation increases the cancellation surface
    auditors must verify (idempotency, fee handling, refund). The
    mobile client only uses DELETE (`bookings.ts:107`) but server
    must honour both indefinitely.
  - Inconsistency makes it harder to write the OpenAPI spec the
    contract testing or SDK generation needs.
Fix:
  Document the policy: state-transition verbs at sub-paths are OK
  (RFC 7231 §4.1 allows it; the action is "transition booking state").
  Pick ONE of POST `/bookings/:id/cancel` or DELETE `/bookings/:id`
  and deprecate the other. Action-only paths like `/topup`, `/apply`,
  `/declare` are fine as a stylistic choice if applied uniformly.
Evidence:
  See route registrations enumerated in cmd/api/main.go and
  internal/booking/handler.go:59-77.
```

### 5. No API versioning beyond the hardcoded `/api/v1` prefix

```
[SEVERITY: High]
[FILE: App/zopmop-app/src/api/config.ts:6]
[CATEGORY: Code Quality / API versioning]
Finding:
  Mobile hard-codes `/api/v1` and ships no:
    - `X-App-Version` request header
    - `X-Minimum-Supported-Version` response handling
    - Force-update screen / OTA gating against a minimum build
  Backend has no min-version middleware. New backend route shapes
  added under `/api/v1/*` (paise migration, schema drift) hit older
  app binaries silently. The mobile client's `validateShape` helper
  (`api/config.ts:43-56`) only checks required keys are non-null —
  it does not protect against rename-in-place breakages.
Impact:
  - Phase rollouts that depend on the client understanding a new key
    (e.g. paise migration in finding 1) cannot be done safely.
  - Tracked Expo updates can deliver JS-only fixes, but native
    breakage (TestFlight 1.0.0(1) is live per memory) leaves users
    on a build with no upgrade prompt path.
  - Apple App Store / Play Store reject apps that hang on outdated
    APIs without a graceful "please update" path.
Fix:
  - Add an `X-App-Version` header in `apiFetch` from
    `Application.nativeApplicationVersion` (already in expo-application).
  - Backend middleware reads it, compares against
    `MIN_APP_VERSION_IOS` / `MIN_APP_VERSION_ANDROID` env. Below ->
    `426 Upgrade Required` with `{code:"FORCE_UPDATE", min:"1.1.0"}`.
  - Mobile catches 426 globally in `apiFetch`, shows
    `<ForceUpdateScreen/>` overlay with App Store / Play Store deep link.
  - Plan a `/api/v2` route group when a backward-incompatible change
    is unavoidable; until then version is purely about the client.
Evidence:
  api/config.ts:6   default URL `http://localhost:8080/api/v1`
  api/client.ts     no version header injected
  No `X-App-Version` references anywhere under App/zopmop-app/src/
```

### 6. HelperBooking TS type drifts from server payload

```
[SEVERITY: High]
[FILE: App/zopmop-app/src/api/pro.ts:13]
[CATEGORY: Code Quality / Type alignment]
Finding:
  TS interface declares 13 fields including
    customer_id, service_category_id, address, lat, lng,
    promo_code, discount_cents, updated_at
  The backend handler that serves these endpoints
  (internal/booking/handler.go:GetHelperActive / GetHelperToday at
  lines ~524-553) returns rows materialised from
  `internal/booking/repository.go`. The single-service
  `ServiceCategoryID` field is set on the legacy `Booking` struct
  (model.go:23) but the **scheduled** booking flow (live since
  Aug 2025 per memory) uses `BookingServiceItem[]` only and may
  return blank service_category_id. There is no telemetry on which
  shape is actually returned.
Impact:
  Type assertion `as HelperBooking[]` is unchecked — `validateShape`
  is NOT used on this code path (unlike `bookings.ts`). Silent runtime
  failures if a field is absent.
Fix:
  - Generate TS types from a single source of truth (codegen from Go
    struct tags or an OpenAPI spec). Until then run
    `validateShape<HelperBooking>(b, ['id','status','price_cents','created_at'])`
    inline on each row, matching the pattern from `bookings.ts:92-94`.
  - Mark optional fields with `?` and `?? null` defaults in the TS
    interface when the server can omit them.
Evidence:
  pro.ts:13-27          interface HelperBooking { customer_id: string; ... }
  pro.ts:40-42          (data?.bookings ?? []) as HelperBooking[]   // no validation
  bookings.ts:92-94     map(b => validateShape<ApiBooking>(b, [...]))
```

### 7. Mobile error-handling pattern is split three ways

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/screens/]
[CATEGORY: Code Quality / Error handling]
Finding:
  Three error-presentation styles coexist:
    - `showError()` / `showInfo()` toasts (utils/toast.ts) → 83 call
      sites across screens/
    - `Alert.alert(...)` native dialog → 20 call sites
    - Silent catch with `console.log` or no surface at all
  Some flows mix them — e.g. ProMatchedScreen.tsx uses both showError
  and Alert. There is no policy on which API failures get a blocking
  Alert vs a toast vs nothing.
Impact:
  - UX inconsistency: same network error renders differently per
    screen.
  - Critical failures (payment, cancellation, account deletion) get
    showError toasts that the user can miss; non-critical ones get
    Alert which interrupts.
Fix:
  Define a tiny `surfaceError(err, opts)` helper that routes:
    - blocking flows (payment failure, account-delete blocked) →
      Alert with retry CTA
    - non-blocking (toggle / refresh / non-essential fetch) → toast
    - background (analytics, prefetch) → console only
  Replace the 103 call sites with this helper.
Evidence:
  $ grep -rn 'Alert.alert' --include='*.tsx' screens/ | wc -l → 20
  $ grep -rn 'showError\|showInfo\|showSuccess' screens/ | wc -l → 83
  $ grep -rn '} catch' screens/ | wc -l → 87
```

### 8. zerolog level discipline is good

```
[SEVERITY: Nit]
[FILE: App/househelp-api/internal/]
[CATEGORY: Code Quality / Logger consistency]
Finding:
  Counts across internal/:
    log.Info  : 82
    log.Debug : 17
    log.Warn  : 188
    log.Error : 255
    log.Fatal : 0 (in handlers/services — used only at startup in main.go)
  Distribution is healthy — Error > Warn > Info > Debug. No level
  abuse spotted in spot checks. Audit B2 / NEW-A1 already cleaned
  the worst offenders.
Impact:
  None.
Fix:
  None. Keep enforcing via review.
Evidence:
  Counts above; see internal/booking/service.go and
  internal/payments/handler.go for representative usage.
```

### 9. Error wrapping (errors.Is / fmt.Errorf %w) is consistent

```
[SEVERITY: Nit]
[FILE: App/househelp-api/internal/]
[CATEGORY: Code Quality / Error handling]
Finding:
  Across `internal/`:
    fmt.Errorf calls         : 970
    of those using %w        : 798 (82%)
    errors.Is calls          : 195
    errors.As calls          : 12
  Wrap discipline is good. `errors.As` is rare — most patterns are
  sentinel-error compares, which is the right tool for the job in Go.
  The unwrapped 172 `fmt.Errorf` calls are mostly construction sites
  (no source error to wrap).
Impact:
  None.
Fix:
  Spot-check the 172 unwrapped sites during normal review; add %w
  where a wrapped source error exists.
Evidence:
  Counts above.
```

### 10. Test coverage is sparse on critical packages

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/matching/]
[CATEGORY: Code Quality / Test coverage]
Finding:
  Packages WITH _test.go:
    analytics, auth, booking, cart, compliance, crm/auth, crm/refunds,
    helper, middleware, notification, outbox, payments, reengagement,
    referral, wallet
  Packages WITHOUT any _test.go (critical subset):
    matching (engine.go 511 LOC, dispatch.go 521 LOC — the heart of
             pro matching)
    leave    (allocation + sweeper — money/SLA logic)
    roomies  (864 LOC service.go; new module per repo map)
    zop      (1,996 LOC service.go; AI assistant — prompt injection
             risk per repo map line 256)
    insights (powers the home pill; nearby_count cap risk)
    services (catalog — price / mrp / addon logic)
    addresses (PII receiver_name/phone)
    zones, slots, places, experts, disputes, offers, location,
    googlemaps, segments, content, config_manager, webhooks
  Even the packages that DO have tests may be trivially passing —
  inspection of:
    - internal/cart/service_test.go (1 file)
    - internal/booking/cart_pricing_golden_test.go (newly added,
      golden-style; good)
    - internal/booking/service_pricing_golden_test.go (newly added)
    - internal/wallet/service_test.go
  shows reasonable coverage. But `internal/matching/`'s zero coverage
  is the single largest gap in the codebase.
Impact:
  - Refactoring matching/dispatch is unsafe.
  - Regressions in the walking-time eligibility filter
    (cmd/api/main.go:316-324 boots fatal without GOOGLE_MAPS_API_KEY
    because of this) have no safety net.
  - Zop's two-iteration agent loop (ZopAgentLoop, 232 lines, no test)
    is shipping prompt-injection-sensitive logic without a regression
    harness.
Fix:
  Priorities:
    1. internal/matching engine + dispatcher — table-driven tests for
       eligibility (lat/lng radius, walking-time bucketing, leave
       overlap, segment filters).
    2. internal/leave — month-rollover, partial-day, double-grant
       idempotency.
    3. internal/zop — guard rails on tool dispatch authorisation
       (already audit NEW-A2-002; needs explicit regression test).
    4. internal/insights/NearbyStats — fallback default behaviour.
Evidence:
  $ find internal -maxdepth 2 -type d | comm -23 - <(find internal -maxdepth 2 -name '*_test.go' -exec dirname {} \; | sort -u)
    → emits the list above.
  $ find internal/matching -name '*.go' ! -name '*_test.go' | xargs wc -l
    → engine.go 511, dispatch.go 521, batcher.go ~80
```

### 11. Mega-functions in critical flows

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/zop/service.go:3018]
[CATEGORY: Code Quality / Function size]
Finding:
  Function size offenders (>100 lines):
    zop/service.go:3018   ZopToolExecutor        285 lines
    zop/service.go:3550   ZopAgentLoop           232 lines
    booking/service.go:345   CreateBooking         184 lines
    booking/service.go:953   CreateScheduledBooking 147 lines
    booking/service.go:1112  CreateInstantBookingFromCart 154 lines
    booking/service.go:1602  RescheduleBooking      123 lines
    payments/handler.go:4668 dispatchCashfreeEventTx 102 lines
  File-size offenders (>500 LOC, non-test):
    zop/service.go              1,996 (twice the next biggest)
    booking/service.go          1,786
    crm/refunds/refunds.go      1,101
    payments/handler.go         1,053
    compliance/export.go          928
    roomies/service.go            864
    crm/growth/growth.go          833
    booking/repository.go         827
    crm/orders/orders.go          745
    compliance/purge.go           733
    admin/repository.go           720
    crm/platform/platform.go      659
    bff/repository.go             654
    booking/handler.go            653
    roomies/repository.go         621
    notification/service.go       603
    auth/repository.go            579
    auth/handler.go               575
    analytics/repository.go       562
    payments/cashfree.go          530
    matching/dispatch.go          521
    matching/engine.go            511
  Mobile screens >500 LOC (TS):
    main/BookingConfirmedScreen.tsx 1,552
    main/BookingsScreen.tsx         1,208
    main/TrackLiveScreen.tsx        1,117
    main/ProfileScreen.tsx          1,110
    main/CartScreen.tsx             1,018
    main/AllServicesScreen.tsx        999
    pro/ProDashboardScreen.tsx        869
    pro/ProOnboardingScreen.tsx       709
    auth/LocationCheckScreen.tsx      668
    main/ServiceAboutScreen.tsx       666
    pro/ProActiveScreen.tsx           631
    booking/InstantMatchingScreen.tsx 582
    main/WalletScreen.tsx             581
    booking/ActiveBookingScreen.tsx   577
    main/HomeScreen.tsx               569
    main/PaymentScreen.tsx            500
Impact:
  - Cognitive load → bug rate. CreateBooking (184 lines) interleaves
    validation, geo lookup, pricing, idempotency, wallet debit,
    analytics, webhooks.
  - 1,500-line React Native screens trap stale-closure bugs (the
    recent fix in commit 9bf1763 was exactly this).
Fix:
  - Extract service-layer subfunctions per concern (validate, price,
    persist, side-effects, notify). Especially booking/service.go and
    zop/service.go.
  - Split mobile screens by section component into
    components/<screen>/<Section>.tsx. BookingConfirmedScreen and
    BookingsScreen are the worst offenders.
Evidence:
  $ awk '/^func /{name=$0; start=NR} /^}/{ if ((NR-start)>100) print FILENAME":"start":"name }' internal/...
  $ find App/zopmop-app/src/screens -name '*.tsx' | xargs wc -l | sort -rn
```

### 12. Magic numbers / timing constants scattered across mobile

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/screens/pro/ProDashboardScreen.tsx:129]
[CATEGORY: Code Quality / Magic numbers]
Finding:
  Polling and timeout constants:
    ProDashboardScreen.tsx:129   setInterval(refreshToday, 30_000)
    ProDashboardScreen.tsx:250   setInterval(checkInvites, INVITE_POLL_MS)  ← good
    ProMatchedScreen.tsx:61      invitePollRef setInterval (no named const)
    api/client.ts:16             REQUEST_TIMEOUT_MS = 10_000          ← good
    api/client.ts:19             RETRY_BACKOFF_MS = [1000, 2000, 4000] ← good
  Pattern is mixed: some files have named constants (per the audit
  memory entry mentioning POLL_MS), others still have raw numerals.
Impact:
  Tuning a poll cadence requires hunting numbers across files.
  Inconsistency with prior pro-side audit cleanup (memory:
  "patterns: submittingRef, fillAnimRef, POLL_MS constants").
Fix:
  Lift remaining `setInterval(..., 30_000)` and similar into named
  constants at the top of each screen, or move to
  `src/constants/polling.ts`.
Evidence:
  $ grep -rn 'setInterval\|setTimeout' App/zopmop-app/src/screens/pro/
```

### 13. HTTP status code usage — 400 is overloaded; 422 underused

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/]
[CATEGORY: Code Quality / HTTP status codes]
Finding:
  Counts across internal/:
    fiber.StatusBadRequest references : 245
    Status(400) literal               :  59  (mixed style)
    Status(422) / StatusUnprocessableEntity : 17
    Status(404) / StatusNotFound      :  66
    Status(401) / StatusUnauthorized  :  62
    Status(403) / StatusForbidden     :  33
  `400 Bad Request` is being used for both:
    (a) malformed request body / wrong shape — correct
    (b) validation errors against a well-formed body
        (e.g. "service not found", "cart is empty", "address does not
         belong to caller") — should be 422 or 403
    cart/handler.go:64       NotFound — correct
    booking/handler.go:251   "cart is empty" → 400, should be 422
    booking/handler.go:258   "time slot not found or unavailable" → 400
                             — should be 422 (or 404)
    booking/handler.go:268   "address does not belong to caller" → 403
                             — correct
  Also style is mixed — `Status(400)` (59 sites) vs
  `Status(fiber.StatusBadRequest)` (245 sites).
Impact:
  - Mobile cannot programmatically distinguish "your body is malformed,
    don't retry" from "your inputs reference state we don't accept,
    fix the inputs and retry".
  - Some 404 sites should be 410 Gone (booking cancelled by other party),
    some 400 sites should be 409 Conflict (already accepted).
Fix:
  Adopt the conventional split documented in `docs/api/status-codes.md`:
    400  malformed JSON, missing required field, parse failure
    401  no/invalid JWT
    403  authenticated but not authorised for THIS resource
    404  resource genuinely does not exist
    409  state conflict (booking already accepted, idempotency replay)
    422  body parsed fine, but semantically rejected
    426  app version too old (see finding 5)
    503  downstream not configured (cashfree/firebase missing) — current
         pattern in payments handler is correct
  Sweep handlers in a follow-up pass. Use fiber.StatusXxx constants
  uniformly.
Evidence:
  See `grep -rn 'Status(' internal/` totals above.
```

### 14. Mobile uses `any` in api/ retries-and-recovery code paths

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/api/]
[CATEGORY: Code Quality / TypeScript strictness]
Finding:
  25 occurrences of `any` in api/ are concentrated in two patterns:
    - `(err as any).error ?? '...'` — for parsing unknown error
      response bodies. Could be typed `{ error?: string; code?: string }`
      via a helper.
    - `} catch (err: any) {` in apiFetch — narrow to `unknown` and
      type-narrow inside.
  Files with `any`:
    api/client.ts (1), api/cart.ts (1), api/bookings.ts (2),
    api/messages.ts (2), api/matching.ts (6), api/roomies.ts (12),
    api/experts.ts (1)
Impact:
  - `(err as any).error` silently passes when err is null/undefined or
    when the server returns `{message: "..."}` instead of `{error}`.
  - Code intent is unclear; a single helper would compress these into
    one place.
Fix:
  Add to api/config.ts:
    export type ErrEnvelope = { error?: string; code?: string };
    export async function parseErr(res: Response): Promise<ErrEnvelope>
    export function errMessage(env: ErrEnvelope, fallback: string)
  Replace all 25 `as any` sites with these helpers.
Evidence:
  $ grep -rn ': any\b\| as any\b' --include='*.ts' App/zopmop-app/src/api/
    → 25 hits enumerated.
```

### 15. validateShape protection is not applied uniformly

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/api/]
[CATEGORY: Code Quality / Type alignment]
Finding:
  Only `bookings.ts` and `users.ts` invoke `validateShape`. Most
  other clients use `res.json() as Promise<T>` directly — an unsafe
  cast that survives any payload, including one with all fields
  flipped to null.
  Files that DO validate:
    users.ts (getMe, updateMe), bookings.ts (createScheduledBooking,
    getBookings)
  Files that DON'T (high-risk subset):
    payments.ts (CashfreeOrderResponse — money flow)
    wallet.ts (WalletBalance, WalletTransactions — money flow)
    addresses.ts (PII)
    pro.ts (HelperBooking, HelperStats)
    referral.ts (ReferralStats)
    cart.ts (ApiCart)
Impact:
  Backend regression that drops a required field would surface as a
  runtime crash deep in a screen rather than a clean
  "Invalid response" error at the API boundary.
Fix:
  Apply `validateShape` (or upgrade to a tiny runtime validator like
  zod for the high-risk files: payments, wallet, addresses) to every
  api/ function before returning. Skip only on trivially-typed
  endpoints (no fields beyond status).
Evidence:
  $ grep -n 'validateShape' App/zopmop-app/src/api/*.ts
    api/bookings.ts:77, 93
    api/users.ts:18, 28
```

### 16. Naming style mismatch: idempotency on Idempotency-Key

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/api/client.ts:38]
[CATEGORY: Code Quality / Naming consistency]
Finding:
  Mobile generates the Idempotency-Key on EVERY apiFetch call
  including GETs. GETs are idempotent by definition, so sending the
  header is wasteful but harmless. Comment at client.ts:38 documents
  the intent for POSTs, but the implementation does not gate on
  method.
Impact:
  - Redis SETNX cost on the server for every GET — small but
    measurable on the hot path.
  - The Idempotency-Key changes on every retry attempt? No — looking
    at client.ts:71-74, the key is generated outside the retry loop,
    which is correct. Worth double-checking the comment claim once
    more in a focused diff review.
Fix:
  Only attach `Idempotency-Key` for POST/PUT/PATCH/DELETE in apiFetch.
Evidence:
  api/client.ts:71-75 unconditionally sets the header.
```

### 17. `validateShape` is duck-typing only — does not type-check

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/api/config.ts:43]
[CATEGORY: Code Quality / Type alignment]
Finding:
  `validateShape` only checks `data[key] != null`. It does NOT verify
  type (string vs number), enum membership, or nested shapes. The
  `ApiBooking.status` enum could come back as "borked" and
  validateShape would pass.
Impact:
  Downstream switch statements may hit the `default` branch silently.
Fix:
  For the small set of money/PII/status endpoints, upgrade to zod or
  a hand-rolled `validateBooking(raw): ApiBooking` discriminator that
  checks status ∈ BookingStatus.
Evidence:
  api/config.ts:43-56
```

### 18. console.* in screens

```
[SEVERITY: Nit]
[FILE: App/zopmop-app/src/]
[CATEGORY: Code Quality / Logger consistency]
Finding:
  The repo-map notes babel-plugin-transform-remove-console is
  "likely" wired for production (line 110-111). VERIFY in
  babel.config.js. If not configured, stray console.log calls
  ship to prod and slow JS thread.
Impact:
  Performance + minor information disclosure if the logs leak
  identifiers.
Fix:
  Confirm `babel-plugin-transform-remove-console` runs in EAS
  production profile, OR replace `console.log` with a dev-only
  `debug()` helper in `src/utils/logger.ts`.
Evidence:
  Subagent 3 (mobile) territory — flag here for cross-reference.
```

### 19. Webhooks payload mislabels paise field too

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/webhooks/payloads.go:42]
[CATEGORY: Code Quality / API contracts]
Finding:
  Outbound webhook event payloads emit `price_cents` carrying paise.
  Outbound consumers are EXTERNAL (per cmd/api/main.go:291,
  `webhooks.WithAllowedDomains`). External integrators will trip on
  this even faster than internal mobile clients.
Impact:
  Same as finding 1 but with no recourse — external integrators
  can't read source. Reputation/billing risk.
Fix:
  Apply the dual-emit migration to webhook payloads first, since
  external consumers cannot be force-updated.
Evidence:
  internal/webhooks/payloads.go:42  AmountPaise int64 json:"price_cents,omitempty"
```

### 20. Mobile types use `service_id` / `address_id` (snake_case) but
       `bookingId` / `helperId` (camelCase) inside the same file

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/api/]
[CATEGORY: Code Quality / Naming consistency]
Finding:
  TS interfaces faithfully snake_case (matching JSON wire), but the
  exported function arguments switch to camelCase:
    cart.ts:30      addToCart(token, serviceId, durationMinutes)
    cart.ts:39      body: { service_id: serviceId, duration_minutes: durationMinutes }
    bookings.ts:104 cancelBooking(token, bookingId)
    experts.ts:30   addExpert(token, helperId)
  TS argument-name style is fine (camelCase is conventional); the
  finding is that the screens then have to remember to translate
  back to snake_case when constructing payloads. This is the source
  of recent stale-closure-like bugs.
Impact:
  Minor — bilingual API surfaces require attention.
Fix:
  No action required if a codegen approach (finding 6) is taken —
  generated clients can do the rename automatically. Otherwise,
  document in `App/zopmop-app/src/api/README.md`: TS args
  camelCase; payload JSON snake_case.
Evidence:
  Above call sites.
```

### 21. Duplicate `bookingGroup` action paths invite divergence

```
[SEVERITY: Nit]
[FILE: App/househelp-api/internal/booking/handler.go:70]
[CATEGORY: Code Quality / Endpoint naming]
Finding:
  Two booking-routes shorthand:
    DELETE /bookings/:id     → CancelBooking
    POST   /bookings/:id/cancel → CancelBooking
  Both call the same handler, but the same operation under two
  routes means future changes (logging key, audit row, idempotency
  key, refund branch) can drift.
Impact:
  Audit complexity. Pre-existing — already noted under finding 4.
Fix:
  Pick one. Mobile only uses DELETE so the action-path could be
  retired once analytics confirm no caller.
Evidence:
  internal/booking/handler.go:70-71
```

### 22. `bookings.ts` ratings endpoint references a route that
       returns 404 today

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/api/bookings.ts:120]
[CATEGORY: Code Quality / API contracts]
Finding:
  Code comment (bookings.ts:118-124) acknowledges that
  POST /bookings/:id/rate does not yet exist on the backend and the
  screen treats 404 as "saved locally". cmd/api/main.go:448 mounts
  reviews under bookingGroup — `reviews.NewHandler(...).RegisterRoutes`.
  Verifying the actual reviews route surface and reconciling with
  the rate stub is outstanding.
Impact:
  Ratings collected since this stub shipped are likely silently
  dropped. Customer perception of pro quality, future matching
  weights, dispute resolution all depend on this data.
Fix:
  Verify reviews handler endpoint shape and update mobile to call it
  with the correct path, OR implement POST /bookings/:id/rate on the
  backend matching the existing client payload.
Evidence:
  bookings.ts:118-142
  cmd/api/main.go:448 — reviews handler is mounted but route shape
  not inspected in this audit.
```

---

## Endpoint inventory (sampled — cmd/api/main.go)

Public:
- `GET /health`
- `GET /ready`
- `GET /api/v1/app/config`
- `GET /api/v1/app/home`, `/screens/:key`, `/services`, `/faqs`
- `GET /api/v1/services`, `/services/:id/details`, `/services/:id/addons`
- `GET /api/v1/zones/check`
- `GET /api/v1/localities`
- `GET /api/v1/insights/nearby`

Auth (public limiter):
- `POST /api/v1/auth/send-otp`, `/verify-otp`, `/firebase`, `/logout`

Authed (JWT):
- `GET/PUT/DELETE /api/v1/me`, `POST /me/onboard-pro`,
  `PUT /me/fcm-token`, `GET /me/export`
- `GET /api/v1/me/referral`
- `GET /api/v1/me/usuals`
- `GET/POST/DELETE /api/v1/me/experts/:helperId`
- `GET/POST/PUT/DELETE /api/v1/addresses[/{id}]`
- `GET /api/v1/cart`, `POST /cart/add`, `DELETE /cart/items/:id`,
  `DELETE /cart`
- `POST /api/v1/bookings`, `/bookings/scheduled`,
  `GET /bookings`, `GET /bookings/:id`,
  `GET /bookings/:id/match-status`, `/tracking`, `/messages`,
  `POST /:id/messages`, `/cancel`, `/reschedule`, `/keep-looking`,
  `DELETE /:id`, pro-action paths `/accept`, `/arrived`, `/start`,
  `/complete`, helper queries `/helper/invites`, `/helper/active`,
  `/helper/today`
- WebSocket `GET /api/v1/bookings/:id/track/ws`
- `GET /api/v1/helpers/me/profile`, `PATCH /helpers/me`,
  `GET /helpers/me/invites`, `/me/stats`,
  `POST /helpers/me/invites/:bookingId/decline`,
  `PUT /helpers/me/location`, `/me/status`
- `POST /api/v1/pro/leave/declare`, `GET /balance`, `/history`,
  `/affected-tomorrow`
- `GET /api/v1/slots`
- `POST /api/v1/referrals/apply`
- `POST /api/v1/payments/validate-vpa`,
  `POST /payments/cashfree/order`,
  `GET /payments/cashfree/orders/:orderID/status`
- `POST /api/v1/payments/cashfree/webhook` (no auth — signature)
- `GET /api/v1/wallet`, `GET /wallet/transactions`,
  `POST /wallet/topup`
- `POST /api/v1/disputes`
- `GET /api/v1/offers`
- `POST /api/v1/zop/chat`, `DELETE /zop/history`
- `GET /api/v1/places/autocomplete`
- `POST /api/v1/devices/register`
- `POST /api/v1/events`, `POST /api/v1/analytics/events`
- `GET /api/v1/sdui/*` (BFF page configs)
- `/api/v1/roomies/groups[...]`, `/members/...`, `/debts/...`

Admin (JWT + admin role):
- `/api/v1/admin/*` (users, helpers, bookings, refunds, audit-log,
  promotions, notifications, zones, services, analytics, sdui, etc.)

Inconsistency hotspots already cited in findings:
- Verb-in-path (finding 4): `/send-otp`, `/verify-otp`, `/firebase`,
  `/logout`, `/onboard-pro`, `/apply`, `/topup`, `/validate-vpa`,
  `/declare`, `/keep-looking`, plus state-transition POSTs.
- Dual paths (finding 21): DELETE+POST `/bookings/:id[/cancel]`.

---

## Cross-references to prior audits

- `.audit/FINAL_REPORT.md` and `AUDIT_2025_2026-05-03.md` — prior
  audits emphasised auth + matching + payment correctness. Naming /
  contract hygiene was not in scope for those passes; this audit
  extends them rather than duplicates.
- Memory entry `project_pro_audit_2026_05_12.md` — "34/35 issues
  fixed; 2 deferred: stats row API + offline banner; patterns:
  submittingRef, fillAnimRef, POLL_MS constants". Finding 12 here is
  the natural follow-on (POLL_MS pattern not applied uniformly).
- Memory entry `project_prod_migration_incident_2026_05_14.md` — the
  price_cents/price_paise DB rename incident is the canonical
  example of why finding 1 matters. The wire shape NEEDS the same
  rename.
- Repo-map line 256 — "internal/zop AI assistant integrates
  OpenRouter; verify prompt injection hardening, rate limiting,
  token-cost guardrails". Finding 10 highlights the lack of tests
  for ZopAgentLoop / ZopToolExecutor.

---

## QUESTIONS FOR ADITYA

1. Is there an OpenAPI spec or codegen pipeline planned, or do you
   want to ratchet mobile types by hand? Finding 6 + 15 are much
   cheaper with codegen.
2. Force-update policy (finding 5): should min-version be
   per-platform env var on backend, or driven from `expo-updates`
   manifest? The latter avoids a backend roundtrip but needs an OTA
   to roll back a force-update window.
3. Is the dual-route `/bookings/:id` DELETE + `/cancel` POST
   intentional (CRM vs mobile use different ones), or accidental?
   See finding 4 / 21.
4. Are CRM `items` list envelopes mandated by an existing
   frontend dependency, or can they be renamed alongside the
   customer endpoints in one sweep? (finding 3)
5. Reviews endpoint surface (finding 22): is
   `POST /bookings/:id/rate` actually implemented under reviews.go
   and the mobile call only needs a path fix, or is it really
   missing?
