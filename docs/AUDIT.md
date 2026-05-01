# ZopMop Pre-Prod Audit (consolidated)

Date: 2026-05-01
Scope: Go backend (`App/househelp-api`) + React Native app (`App/zopmop-app`).
Method: 5 parallel audit agents — backend security, backend reliability, RN app, hygiene/ops, UX booking funnel.

---

## P0 — Blocks prod (security, data loss, crashes)

### Security / AuthZ

- **`internal/auth/service.go:261` — Self-service privilege escalation customer→pro**
  - What: `OnboardPro` (POST `/me/onboard-pro`) lets any customer JWT flip own `users.role = 'pro'` and insert into `helpers` with no KYC, admin gate, doc upload.
  - Why bad: bad actor instantly receives booking invites + customer addresses.
  - Fix: gate behind admin approval (pending state) + government-ID upload before `pro` grant.

- **`internal/location/handler.go:177` — IDOR on live helper coords (stalking)**
  - `GET /location/helper/:id` does no booking-association check. Any authed user reads any pro's live lat/lng.
  - Fix: require active booking between caller and helperID, or limit to admin/self.

- **`internal/booking/service.go:414` — IDOR on `address_id` in scheduled booking**
  - `CreateScheduledBooking` accepts arbitrary `address_id`/`time_slot_id`; no `WHERE address_id IN (caller's addresses)`. Customer can book against another user's home; helper dispatched there.
  - Fix: `SELECT 1 FROM user_addresses WHERE id=$1 AND user_id=$2` before insert.

- **`internal/addresses/repository.go:187` — Cross-user booking corruption on address delete**
  - Delete runs `UPDATE bookings SET address_id=NULL WHERE address_id=$1` BEFORE owner check. Stranger passes any addressID → nullifies every booking referencing it.
  - Fix: verify ownership first or join in `WHERE`.

- **`internal/roomies/handler.go:34, service.go:711, :781` — Roomies financial reads no membership check**
  - `GET /roomies/groups/:id/ledger` and `/vault` return every member's debt + balance to any authed user knowing/guessing groupID.
  - Fix: enforce `IsMember(callerID, groupID)`.

- **`internal/roomies/service.go:421` — Non-member can drain another member's prepaid balance**
  - `BookGroupChore` doesn't check initiator membership. Non-member submits chore order with self as initiator; charges victim's balance.
  - Fix: assert initiator membership upfront.

- **`internal/services/handler.go:31` + `internal/zones/handler.go:25` — Admin endpoints missing `RequirePermission`**
  - `POST/PATCH/DELETE /admin/services` and `/admin/zones` only behind `AdminMiddleware`; any admin row bypasses `PermManageServices` / `PermManageConfig`.
  - Fix: wrap with `RequirePermission(...)`.

### Data integrity

- **`internal/roomies/service.go:382-394, repository.go:119,140` — Money loss on group force-delete**
  - Force-delete zeroes member `prepaid_balance` with TODO `credit to main wallet` — wallet doesn't exist. Real customer money disappears.
  - Fix: block force-delete OR write to `pending_refunds` row before zeroing.

- **`internal/booking/repository.go:430-471` (promo) interaction — `max_uses` exceedable**
  - Booking + promo increment race; `FOR UPDATE` exists on row but booking insert + increment not in single tx.
  - Fix: wrap createBooking + incrementPromoUsage in `BeginTx`.

- **`POST /bookings` no idempotency key**
  - Network-retried client creates duplicate bookings + duplicate matching attempts.
  - Fix: accept `Idempotency-Key` header; dedupe via Redis `SETNX` + cached response.

- **`internal/roomies` JoinGroup non-atomic** — orphans address copies or members on partial failure. Wrap in tx.

### Crashes

- **No `recover()` in spawned goroutines** (booking/service.go, matching/engine.go fire-and-forgets) — single panic crashes API process.
  - Fix: helper `func safeGo(fn func()) { go func(){ defer recover(); fn() }() }`.

- **No top-level ErrorBoundary in RN app**
  - Any uncaught render error → blank red screen.
  - Fix: wrap `<NavigationContainer>` in ErrorBoundary that resets nav state.

- **`InstantMatchingScreen.tsx:135, 203-218` — Untracked `setTimeout` chains fire post-unmount**
  - Nested timers call `setScreenState` + `navigation.replace` after teardown → React warning + ghost navigation.
  - Fix: push every timer into `pendingTimers` ref array; clear in cleanup.

### Secrets / Ops

- **`App/househelp-api/.env:17` + `App/zopmop-app/.env:2` — Real Google Maps API key in working tree**
  - Files gitignored — but key likely shared via repo at some point. Verify `git log --all -- .env`. Rotate now.
- **`App/househelp-api/secrets/zopmop-4a87c-firebase-adminsdk-fbsvc-6f853420fb.json`** — Firebase admin service account on disk. Verify never pushed; rotate if doubt.

---

## P1 — Must fix in first sprint (reliability, perf, auth)

### AuthN/AuthZ

- **`internal/middleware/auth.go:62` — JWT suspension lag up to 24h.** No revocation list; `is_suspended` only re-checked at fresh OTP. Add Redis revocation set keyed by user_id with `tokens-issued-before` timestamp.
- **`internal/auth/service.go:200` — No JWT refresh/rotation.** 24h HS256, no jti, no revocation. RN signs out on JWT expiry. Implement short access (15m) + refresh-rotation.
- **`internal/auth/service.go:119` — OTP stored cleartext in Redis.** Anyone with Redis read access intercepts. Store HMAC.
- **`internal/auth/handler.go:139` — OTP echoed in dev response.** `cfg.IsDevelopment()` is string equality on `ENV`; misset env leaks OTPs. Gate behind explicit `OTP_DEBUG=true`.
- **`internal/auth/firebase.go:31` — Firebase init not project-scoped.** Pass `&firebase.Config{ProjectID: cfg.FirebaseProjectID}`; assert `token.Audience == projectID`.
- **`internal/booking/handler.go:36` — `POST /bookings/:id/cancel` not gated to customer role.** Pro JWT can force customer-cancel transition. Restrict to `CustomerID` match.
- **`internal/auth/service.go:100` — No per-phone daily SMS cap.** Toll-fraud: 1 OTP/min × 1440 min. Add 24h-max counter per phone.
- **`internal/middleware/admin.go:42` — Permission cache 5-min poison window.** Tightened admin perms persist until TTL. Invalidate on permission change.

### Reliability

- **`internal/location/handler.go:124-171` — WebSocket no idle timeout post-auth.** `SetReadDeadline` via app heartbeat.
- **`internal/helper/service.go` — `UpdateLocation` force-flips `is_available=true`.** Pros can't stay offline. Decouple availability from location update.
- **`internal/admin/repository.go:580` `GetCustomerFCMTokens` un-paginated broadcast.** OOM at scale + >500 multicast token failure. Paginate.
- **`internal/roomies/cron.go:16` `AutoSettleCron` has no `Stop()`.** Blocks clean shutdown drain.
- **Redis pool size default 10** — production saturation. Tune `redis.Options.PoolSize`.
- **`internal/middleware/admin.go:43, ratelimit.go:118` — `context.Background()` ignores request lifecycle** for Redis ops. Use `c.Context()`.
- **`internal/booking/service.go:521, 618` — `_ = s.db.QueryRow(...).Scan(...)`** swallows pg errors; helper coords default to 0 silently.
- **`internal/insights/service.go:65-66, 82-85` — Redis errors silently swallowed.** `/insights/nearby` returns "0 pros" on Redis blip → home pill broken.
- **`internal/insights/handler.go:43, 63` — 500 on Redis blip kills home pill.** Fail-soft: return 200 with empty stats.
- **`internal/auth/service.go:288` `DeleteAccount` doesn't invalidate active JWTs.** Soft-delete only; existing tokens valid for 24h.
- **No Dockerfile, no eas.json, no CI** — cannot produce deployable artifact. Add minimal Dockerfile + `.github/workflows/ci.yml` + `eas.json`.
- **`pkg/config/config.go:63` — `ENV` defaults to `"development"`.** Default to `"production"`; require explicit `ENV=development` opt-in.
- **`cmd/api/main.go:108-113` — `/health` is liveness-only.** Add `/ready` that pings dbPool + rdb with 1s timeout.
- **No migration runner** (no `goose`/`golang-migrate`/`dbmate`). Wire `golang-migrate`.
- **No Sentry / Crashlytics / Prometheus.** Wire Sentry SDK in RN + Fiber. Expose `/metrics` (promhttp).

### RN

- **`src/api/users.ts:8` — `triggerSignOut()` on 404 from `/me`** — restrict to 401/403.
- **`src/screens/pro/ProActiveScreen.tsx:100-113` — WebSocket no reconnect/backoff.**
- **`src/screens/pro/ProActiveScreen.tsx:194, ProDashboardScreen.tsx:158` — GPS heartbeats run while backgrounded.** Pause on `AppState=background`.
- **`src/screens/pro/ProDashboardScreen.tsx:158` — Interval stacking on rapid online toggle.**
- **`src/screens/pro/ProMatchedScreen.tsx:90` — `navigation.goBack()` inside `setSecondsLeft` updater.** Move out.
- **`src/hooks/usePushNotifications.ts:5` — stub.** Re-enable.
- **15 `console.*` calls in production paths.** Strip via babel plugin.

### API contract

- **Banner/service admin endpoints skip `validator.Validate.Struct`** (`content/handler.go:174`, `services/handler.go:97,122`).
- **String-compared error messages route 4xx vs 5xx** (`booking/handler.go:71,252`, `cart/handler.go:63`, `services/handler.go:112`). Replace with sentinel errors + `errors.Is`.
- **`internal/insights/handler.go:32-39` — `lat`/`lon` not range-checked.**
- **`internal/places/handler.go:25` — `q` no length cap.** Cap 2-100 chars.
- **`internal/analytics/handler.go:117` — No size cap on `properties` map.**
- **`internal/analytics/sanitizer.go:5` — Sensitive-key blocklist tiny.** Expand.

---

## P2 — Should fix soon (hygiene, observability, perf)

### Observability

- Request-ID set on response (`security.go:77-80`) but NOT injected into per-handler `log.Error()` lines.
- Mobile client doesn't send `X-Request-ID`. Generate in `apiFetch` (`src/api/client.ts:28`).
- Missing structured logs at error boundaries: `insights/handler.go:43,63`; `helper/handler.go:63`; `auth/handler.go:309,327,343`.
- `notification/service.go:62` — uses `log.Debug` for FCM lookup failures.

### PII in logs

- `internal/auth/service.go:129, 172, 215, 218, 222, 225, 229; handler.go:134, 183` — phone logged at INFO. Mask to last 4.
- `internal/zones/handler.go:51, matching/engine.go:84,211,216,221,567, googlemaps/client.go:118` — exact lat/lng logged. Round to 2 decimals.

### Hardcoded values that should be config

- `internal/auth/service.go:18-20`, `internal/middleware/admin.go:21`, `internal/insights/service.go:15-20`, `internal/googlemaps/client.go:36`, `analytics/service.go:16`, `content/service.go:14`, `config_manager/service.go:14`, `roomies/service.go:20`.
- `cmd/api/main.go:147,172,179` — matcher tick / rollup / re-engagement.

### Auth flow gaps

- `internal/auth/handler.go:147` `POST /auth/firebase` shares auth limiter; no Firebase-specific guard.
- `cmd/api/main.go:229` — `/auth/*` shared 20/min limiter; verify should be ~5/min.
- `internal/booking/handler.go:33` `POST /bookings` only behind 100/min; add 5/min create limiter.
- `internal/helper/handler.go:28` `PUT /helpers/me/location` 100/min; dedicate 30/min.
- `internal/middleware/csrf.go:50` — `/auth/logout` shouldn't bypass CSRF.

### Migrations

- 32 forward, **zero `*.down.sql`**. Either commit forward-only policy or add downs.
- `migrations/001_create_users.sql:8` — `phone` plain VARCHAR. GDPR/DPDP: column-level encryption (pgcrypto).

### Inconsistent error envelopes

- Mix of `{"error"}`, `{"message"}`, `{"error","fields"}`, `{"error","retry_after_seconds"}`. Standardize.

### Mobile perf

- `HomeScreen.tsx:262-321` — `slides` array recreated each render. `useMemo`.
- `HomeScreen.tsx:407-457` — `ServiceCard` not memoized; `React.memo`.
- `HomeScreen.tsx:116-200` — mega-effect with stale `services` closure.
- `HomeScreen.tsx:105-113` — duplicate `listServices()`.
- `HomeScreen.tsx:229-235` — 5s `getNearbyStats` poll. Bump to 15-30s.
- `InstantMatchingScreen.tsx:78-92` — `Animated.loop().start()` no `stop()` in cleanup.

---

## Dead code to delete

- `App/househelp-api/api` — empty placeholder file.
- `App/househelp-api/docker-compose.yml.save` — backup.
- `App/househelp-api/.run/server.log` — committed runtime log. Add `.run/` to gitignore.
- `App/zopmop-app/.run/ios.log`.
- `App/zopmop-app/.expo/xcodebuild.log`, `xcodebuild-error.log`.
- `App/zopmop-app/.superpowers/brainstorm/3951-1777568342/`.
- `App/househelp-api/.worktrees/booking-side-effects-outbox/`.
- `App/househelp-api/optimization_plan.md`, `App/househelp-api/plan.md`.
- `report/report.md`.
- Duplicate `NotServiceableScreen.tsx` in `screens/auth/` and `screens/main/`.
- `src/constants/tokens.ts` — fold into `src/theme/`.
- `App/househelp-test-client/` — separate; move to tools/ or other repo.
- TODOs in `internal/roomies/{service.go:346,382,389,394; repository.go:119,140; model.go:170}`.
- `internal/booking/service.go:221` — TODO cancellation fee.
- `internal/booking/handler.go:131` "Legacy path".
- `internal/middleware/ratelimit.go:179` "Legacy fallback".

## Dependencies / config

- `App/zopmop-app/package.json` — every dep `^`/`~`. Enforce `npm ci` in CI.
- `app.json:5` — no `ios.buildNumber` / `android.versionCode`.
- `app.json:9` — `userInterfaceStyle:"light"` despite ThemeContext supporting both.
- `app.config.js:14-23` — Maps key from env at build; no `eas.json`.
- `app.json:17` — verify `react-native-razorpay` new-arch compat.
- No swagger/OpenAPI.

---

## UX (booking funnel)

### Top 3 friction points

1. **`ServiceAboutScreen.tsx:48,158`** — `duration = null` initial; price `—`, "Select duration" while bottom shows ₹25. Looks broken.
2. **`InstantMatchingScreen.tsx:29,116-130,333`** — `MATCH_DURATION = 60000` but copy "Usually takes less than 30 seconds". Bar plateaus at 30s; users back out → silent cancellation.
3. **`CartScreen.tsx:354-356, 597-611`** — CTA "Pay Now" fires `Alert.alert('Booking Confirmed!')` with no payment + no real receipt.

### Quick win

`ServiceAboutScreen.tsx:48` — `useState<number | null>(service.min_duration_minutes)` instead of `null`.

### Cross-cutting UX

- **Font scale**: `xs=11, sm=13, base=15` — body should be ≥16. Bump globally.
- **Touch targets**: many <44×44 (addBtn 26, stepBtn 24, removeBtn 28, backBtn 36).
- **Contrast fail**: `textMuted = #9CA3AF` on white → 2.85:1.
- **11 `Alert.alert`** in funnel — replace info/success with toasts/screens.
- **Missing `accessibilityLabel`** on every icon-only `TouchableOpacity`.
- **Inverted swipe convention** in AddressesScreen `:87`.

---

## TOP 5 RISKS — fix BEFORE prod push

1. **`internal/auth/service.go:261` self-service `OnboardPro`** — anyone becomes a pro instantly.
2. **`internal/location/handler.go:177` IDOR on live helper coords** — stalking primitive.
3. **`internal/roomies/service.go:382-394` money zeroed on group force-delete** — refund liability.
4. **No CI, no Dockerfile, no eas.json, no migration runner, no Sentry/Crashlytics/Prometheus** — no clean deploy path + production blind.
5. **`pkg/config/config.go:63` `ENV` defaults to development** — misset env ships HSTS-off + dev-mode JWT + OTP-echo.
