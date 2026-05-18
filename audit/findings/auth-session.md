# Auth & Session — Subagent 3 Findings

Scope: backend Go/Fiber auth (`internal/auth`, `internal/middleware`,
`internal/credentials`, `internal/users`, `cmd/api/main.go`) + mobile
RN/Expo auth surfaces (`src/context/AuthContext.tsx`, `src/screens/auth/*`,
`src/services`, `src/hooks/usePushNotifications.ts`, `src/api/devices.ts`,
`src/api/client.ts`).

Approach: read every protected route registration in `cmd/api/main.go`,
walked the middleware chain, then cross-checked each domain handler for
in-handler role/ownership assertions. Mobile side: traced sign-in,
silent-refresh, sign-out, push-token lifecycle.

Cross-references prior audits where applicable (`AUDIT_2025_2026-05-03.md`
at repo root). New findings dominate.

---

## Route map — every `/api/v1/*` route with its middleware chain

`cmd/api/main.go:428-731`. Order of middlewares left-to-right per
Fiber `Group(prefix, ...handlers)`.

### Public (no auth middleware)
- `GET /health` (publicLimiter) — `main.go:234`
- `GET /ready` (publicLimiter) — `main.go:242`
- `POST /api/v1/auth/send-otp`        (authPublicLimiter) — `auth.handler.go:96`
- `POST /api/v1/auth/verify-otp`      (authPublicLimiter) — `auth.handler.go:97`
- `POST /api/v1/auth/firebase`        (authPublicLimiter) — `auth.handler.go:98`
- `POST /api/v1/auth/logout`          (authPublicLimiter) — `auth.handler.go:99`
- `GET  /api/v1/app/*`                (publicLimiter) — content + config
- `GET  /api/v1/services/*`           (publicLimiter, dbBoundLimiter)
- `GET  /api/v1/zones/check`          (publicLimiter)
- `GET  /api/v1/localities/*`         (publicLimiter)
- `GET  /api/v1/insights/nearby`      (publicLimiter, dbBoundLimiter)
- `POST /api/v1/payments/cashfree/webhook` — registered under the auth-protected
  `paymentsGroup` but bypassed at the middleware via `IsUnauthenticatedPath`
  (`middleware/auth.go:47`). Authenticated via x-webhook-signature inside the
  handler.

### Authenticated (authMiddleware + authLimiter [+ dbBoundLimiter])
Chain at `main.go:440-441`. JWT validated via `ParseJWTClaims`, live
suspension check via `authRepo.IsSuspended`.

- `/api/v1/bookings/*` — `main.go:444`. Pro-only endpoints (accept, arrived,
  start, complete, helper invites/active/today) additionally chain
  `RequireRole("pro")` + `helper.RequireApproved(repo)` inside the
  `booking.Handler.RegisterRoutes` factory (`booking/handler.go:45-77`).
- `/api/v1/bookings/:id/track/ws` — `main.go:454-455`. NOT wrapped in
  `authMiddleware` (HTTP→WS upgrade can't carry the Authorization header
  reliably). Auth enforced inside the WS by `{"type":"auth","token":...}`
  (`booking/tracking_ws.go:104`).
- `/api/v1/location/*` — `main.go:458`. Includes WS sub-route at
  `/location/ws` which does NOT use authMiddleware; auth via in-band
  handshake (`location/handler.go:71`).
- `/api/v1/addresses/*` — `main.go:462`
- `/api/v1/cart/*` — `main.go:470`
- `/api/v1/offers` — `main.go:474` (no path prefix, mounted on `""`)
- `/api/v1/disputes` — `main.go:478`
- `/api/v1/slots/*` — `main.go:482`
- `/api/v1/zop/*` — `main.go:502` adds `mw.Timeout(90s)` +
  `RequireRole("customer")` — only customer JWTs admitted.
- `/api/v1/places/*` — `main.go:507`
- `/api/v1/payments/*` — `main.go:517`
- `/api/v1/wallet/*` — `main.go:528`
- `/api/v1/me/*` — `main.go:549` (mounts auth + insights + experts +
  referral me-routes including `DELETE /me`, `PUT /me/fcm-token`,
  `GET /me/export`, `POST /me/onboard-pro`, `GET /me/referral`)
- `/api/v1/devices/register` — `main.go:586`
- `/api/v1/helpers/*` — `main.go:590`. Internal chain adds
  `RequireRole("pro")` and a per-route `RequireApproved` band
  (`helper/handler.go:37-50`).
- `/api/v1/pro/leave/*` — `main.go:609` adds `RequireRole("pro")` +
  `RequireApproved`.
- `/api/v1/admin/*` — `main.go:620` adds `AdminMiddleware` (role==admin
  + permission cache).
- `/api/v1/sdui/*` — `main.go:708`
- `/api/v1/admin/sdui/*` — `main.go:713` nested under adminGroup +
  `SduiAdminAuth`.
- `/api/v1/events`           — `main.go:719`
- `/api/v1/analytics/events` — `main.go:721`
- `/api/v1/roomies/*` — `main.go:727`
- `/api/v1/referrals/*` — `main.go:567`

Observation: every `Group()` registration goes through `authMiddleware`
except the four public groups plus the WebSocket entry points which
authenticate in-band. **No bypass identified.** Prior audit
`AUDIT_2025_2026-05-03.md:131-133` reached the same conclusion; this
audit confirms no regression. The `IsUnauthenticatedPath` short-circuit
is narrow and explicit (`auth.go:47` — only `payments/cashfree/webhook`).

---

## Findings

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/middleware/auth.go:139-145]
[CATEGORY: Auth & Session / suspension-check fail-open]
Finding:
AuthMiddleware falls back to the JWT-baked is_suspended claim when the
SuspensionChecker is nil. Wiring in cmd/api always passes authRepo
(main.go:440), so the production path uses the live DB read — but the
fallback branch remains. A future refactor that drops the checker (e.g.
a new entrypoint forgetting the wire) silently reverts to the legacy
behaviour where admin suspension takes up to JWT_EXPIRY_HOURS to land.
The same fallback is duplicated in two WebSocket handshakes
(booking/tracking_ws.go:139, location/handler.go:150). Same risk.
Impact:
Stale `is_suspended=false` claim from a 24h-old JWT means a banned
account can keep transacting until token expiry. The prior audit
(AUDIT_2025_2026-05-03 / A5-06 chunk 16) is what motivated the live
check — keeping the fallback re-opens the gap as a one-line bug.
Fix:
Remove the JWT-claim fallback. If checker == nil, fail-closed
(`return c.Status(503).JSON(...)` matching the DB-error branch). The
"tests/older binaries" rationale in the comment block (auth.go:64) is
satisfied by injecting a fake checker in tests; production never
constructs the middleware without one.
Evidence:
internal/middleware/auth.go:139, internal/booking/tracking_ws.go:139,
internal/location/handler.go:150.
```

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/auth/handler.go:67-92, App/zopmop-app/src/context/AuthContext.tsx:329-346]
[CATEGORY: Auth & Session / logout — no server-side invalidation]
Finding:
`POST /auth/logout` clears the HttpOnly cookie and returns 200 (handler.go:278).
It does not invalidate the JWT itself. There is no token blocklist, no
per-user token-version column, and no `jti` claim in `generateJWT`
(service.go:368). Mobile signOut (`AuthContext.tsx:329-346`) deletes the
SecureStore key but never calls `/auth/logout`, never calls
`DELETE /devices/:id` (no such endpoint exists — see separate finding),
and never tells the backend to drop the FCM token.
Impact:
A copied JWT remains valid until natural expiry (JWT_EXPIRY_HOURS=24,
config.go:102). Logout has no security effect — only convenience. A
stolen token (lost-device, malware) cannot be revoked except by
admin-suspending the account. Mobile signOut leaves the FCM device row
intact on the backend, so a subsequent owner of the same physical
device that never re-signs in still receives the old user's pushes
until the FCM token rotates organically.
Fix:
1. Add a `token_version` int column to `users`; embed it in the JWT
   claims; the middleware rejects when DB version != claim version.
   Logout bumps the version. (Lightweight, no separate revocation
   table.)
2. Add `DELETE /devices` (or `DELETE /devices/:device_id`) that the
   mobile signOut must call before clearing SecureStore.
3. Mobile signOut should `await fetch('/auth/logout')` and the new
   delete-device call before wiping local state (best-effort, capped
   by a short timeout — failure must not block local sign-out).
Evidence:
internal/auth/handler.go:278-281 (Logout is a 4-line cookie clear),
internal/auth/service.go:368-389 (no jti, no token version in claims),
App/zopmop-app/src/context/AuthContext.tsx:329-346 (signOut is local-only),
App/zopmop-app/src/api/devices.ts (only registerDevice, no delete).
```

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/middleware/jwt.go:25, internal/auth/service.go:367-389]
[CATEGORY: Auth & Session / JWT validation — no replay protection, no nbf]
Finding:
JWTs are issued with iss / iat / exp / user_id / role / is_suspended only
(service.go:371-378). No `jti` (unique token id) and no `nbf` (not-before)
are present. Verification (middleware/jwt.go:25) uses the library default
parser — no `WithLeeway`, no replay cache. The library does check exp
default-tightly (no skew), so two devices with even a few seconds of clock
drift between issuer and verifier will (correctly) reject newly-issued
tokens.
Impact:
- No `jti` ⇒ a token captured anywhere (transit, logs, crash reports,
  PostHog, Sentry) can be replayed up to 24h. Combined with the no-server-
  side-revocation finding above, the blast radius of any single leak is
  24 hours.
- No `WithLeeway` ⇒ Railway clock drift vs client clock can produce
  spurious 401s. The mobile app's silent-refresh masks this most of the
  time but pro-side WebSocket reconnect storms have been seen in past
  audits.
Fix:
- Add `jti` (UUIDv4) to every issued token. Maintain a short-lived
  Redis "revoked-jti" set populated on logout / suspension; check on
  validation. TTL = remaining exp. Cost: 1 Redis GET per request — cheap
  next to the live suspension PK lookup already added.
- Add `parser.WithLeeway(60*time.Second)` to ParseJWTClaims; mobile
  clocks routinely drift on India networks.
Evidence:
internal/middleware/jwt.go:25 (no WithLeeway), internal/auth/service.go:371-378
(no jti), go.sum confirms golang-jwt/v5 (supports WithLeeway).
```

```
[SEVERITY: High]
[FILE: App/zopmop-app/src/context/AuthContext.tsx:13-19, 317-336]
[CATEGORY: Auth & Session / mobile token storage]
Finding:
The JWT is stored via `expo-secure-store` with NO options
(SecureStore.setItemAsync(TOKEN_KEY, jwt)). Defaults differ per
platform:
- iOS: uses Keychain class `kSecAttrAccessibleAfterFirstUnlock` (good).
- Android: uses Android Keystore-backed AES per-app key, BUT no
  `requireAuthentication`. On rooted / unlocked-bootloader devices the
  shared-prefs entry is decryptable.
Acceptable for an MVP — but combined with the 24h JWT TTL + no
server-side revocation, a rooted device + reverse-proxy MITM can
replay until natural expiry.
Impact:
Low day-to-day risk (Keychain/Keystore is industry baseline). Becomes
material in tandem with the "no server-side invalidation" finding. Also
note: AsyncStorage is used for `auth.has_accepted_privacy_policy`
(OTPVerificationScreen.tsx:126) — fine, non-secret.
Fix:
- Continue using SecureStore but consider passing
  `keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY` on
  iOS (prevents iCloud Keychain sync) and revisit Android `accessGroup`
  when biometric gating is added.
- The bigger win is server-side revocation (see jti finding above);
  it bounds the blast radius of a key extraction.
Evidence:
src/context/AuthContext.tsx:317, 334 (no opts on set/delete).
```

```
[SEVERITY: High]
[FILE: App/zopmop-app/src/context/AuthContext.tsx:79-92, App/househelp-api/internal/auth/handler.go:342-360]
[CATEGORY: Auth & Session / Firebase silent refresh — double-mint race]
Finding:
tryFirebaseSilentRefresh issues a fresh ID token and exchanges it for a
backend JWT every time the app launches with no stored token (or with a
rejected one). The backend's `/auth/firebase` route is rate-limited by
IP (authPublicLimiter, 20/min — SensitivePublicRateLimit) but NOT
deduplicated per Firebase UID. If two tabs / two parallel restore() runs
race (e.g. push-notification cold-start + AppState foreground transition
both fire), two backend exchanges happen, each generates a NEW JWT
(same user, distinct exp/iat). Both are valid for 24h.
Impact:
Token sprawl: multiple unrevocable JWTs per user from a single device.
Compounds the "no server-side revocation" problem — even if you bump a
token_version later, you must ensure all sibling tokens are evicted.
Also no `jti` so they are indistinguishable in logs.
Fix:
Serialize silent-refresh attempts via a module-level promise mutex
(only one in-flight call ever). Already partly done — the marker check
guards the first launch — but the AppState foreground listener +
restore() can both call it.
Evidence:
src/context/AuthContext.tsx:166-280 (restore + AppState listener both
can mint via trySilentFirebase), no mutex around tryFirebaseSilentRefresh.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/auth/service.go:340-342, internal/auth/repository.go:557-579]
[CATEGORY: Auth & Session / FCM device hand-off]
Finding:
RegisterDevice upserts on `(device_id, platform)` and overwrites the
prior owner's `user_id` / `worker_id` columns (repository.go:566-578).
But because the device_tokens row is a *single row per device*, the
"detach previous owner" effect only fires when the new owner calls
RegisterDevice. Concretely:
- User A signs in on a phone → device_tokens row carries user_id=A.
- User A signs out (mobile-only, no DELETE call — see finding above).
- Phone is now unauthenticated. FCM token is still bound to user A on
  the backend. A push for A still lands on the phone.
- User B signs in on the same phone → the new RegisterDevice flips the
  row to user_id=B (good).
But between the sign-out and the next sign-in, A's push delivery is
broadcasting to the wrong recipient. For shared phones / household
hand-down devices common in India this is realistic.
Impact:
PII leak via push tray. A logged-out user's bookings, OTPs, payment
status, and Pro invites appear on the now-unauthenticated phone.
Fix:
- On signOut, mobile must call a new `DELETE /devices` (which scrubs
  the row for the current device_id). Pair with the logout-invalidation
  fix above so it's a single round-trip.
- Server-side worker: a daily sweep that prunes device_tokens with
  `updated_at < now() - 90 days` (the FCM token rotation cadence).
Evidence:
internal/auth/repository.go:557-579 (no delete API),
src/api/devices.ts (no unregister function), src/context/AuthContext.tsx:329-346.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/auth/repository.go:427-440]
[CATEGORY: Auth & Session / phone recycling]
Finding:
SoftDeleteUser rewrites the soft-deleted row's `phone` column to a
deterministic placeholder (`'del:' || substr(id::text, 25, 12)`). This
frees the original phone for re-registration. Subsequent SendOTP for
that phone returns isNewUser=true, CreateUser inserts a fresh row, the
new user gets a fresh UUID and a fresh role.
This is correct for telco-recycled numbers (Indian telcos commonly
recycle numbers after 90-day dormancy). But the *prior* user's
in-flight artifacts (booking_messages with the anonymised sentinel,
reviews, audit log entries) still carry the old UUID. New user can
never see them — there is no UUID collision. Verified.
However, no audit log entry is written when a phone is reassigned to
a new UUID. A user who reports "I'm seeing someone else's bookings"
would have no forensic trail.
Impact:
Low. The data isolation is correct. The forensic-trail gap matters
for support / DSAR investigation only.
Fix:
On CreateUser when GetUserByPhone returned a soft-deleted match
(currently impossible because GetUserByPhone filters `deleted_at IS NULL`),
emit a `user.phone_reassigned` audit_log row tying the new UUID to
the previous one. Cheap insurance.
Evidence:
internal/auth/repository.go:104-121, 427-440, internal/auth/service.go:213-221.
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/auth/firebase.go:34-50]
[CATEGORY: Auth & Session / Firebase singleton — no re-init on credentials rotation]
Finding:
getFirebaseClient uses sync.Once so the Firebase Auth client is built
once per process. FIREBASE_CREDENTIALS_JSON is read at first call only.
A credentials rotation (e.g. Firebase service-account key compromise)
requires a process restart to take effect — Railway re-deploy handles
this, but operationally it's worth flagging.
Impact:
Low. Standard pattern; no current incident. But: if firebaseErr is set
(e.g. transient cred load failure), every subsequent VerifyFirebaseToken
returns ErrFirebaseClientUnavailable forever until restart. Already
flagged by AUDIT_2025_2026-05-03.md:166 in a different form.
Fix:
Detect firebaseErr != nil at call site and retry init once per minute
behind a mutex. Or accept and document the "restart on cred rotation"
operational constraint.
Evidence:
internal/auth/firebase.go:34-50.
```

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/context/AuthContext.tsx:73, 79-94]
[CATEGORY: Auth & Session / Firebase ID-token transport unauthenticated by JWT]
Finding:
tryFirebaseSilentRefresh's call to `${BASE_URL}/auth/firebase` uses raw
`fetch`, not the apiFetch wrapper (client.ts). It therefore has no
X-Request-ID and no Idempotency-Key. The same is true of the initial
PhoneEntry → OTPVerification → /auth/firebase exchange
(OTPVerificationScreen.tsx:107).
Impact:
Operational only — harder to correlate the silent-refresh storm in
backend logs with a specific client. Not a security finding per se.
Fix:
Switch to apiFetch (it skips its own 401 → signOut path naturally for
public endpoints since there's no token to invalidate).
Evidence:
src/context/AuthContext.tsx:79-94 (raw fetch),
src/screens/auth/OTPVerificationScreen.tsx:107 (raw fetch).
```

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/api/client.ts:38-40, 77]
[CATEGORY: Auth & Session / idempotency-key collision via Math.random]
Finding:
The mobile client mints an Idempotency-Key per apiFetch invocation from
`Math.random()` — not crypto-secure (client.ts:38). It is reused across
retries in the same call (good) but a per-(user, 10-min) collision is
plausible at scale (~6 hex chars of entropy total). The backend
idempotency middleware (per file header) namespaces by user_id + 10-min
window, so a collision means the SECOND request returns the cached
response of the FIRST — a real cross-action data leak.
Impact:
Probability is small (key is ~13 chars of base36) but the failure mode is
silent and severe: the second request returns the wrong cached response.
Combined with the booking-create path (where the user expects an
idempotent 201 but might get an unrelated 200), this is a correctness
+ trust bug.
Fix:
Use `crypto.randomUUID()` (available on modern RN runtimes) or
expo-crypto's getRandomBytes. The server should also enforce a minimum
key length and a minimum entropy proxy via byte-set size to fail-fast
on obviously-trivial keys (e.g. callers passing the same string).
Cross-reference: AUDIT_2025_2026-05-03.md flagged a related issue
(E2D-1 collapsed-namespace) that was fixed via the LocalsKeyUserID
constant (middleware/locals.go:13). The current collision risk is a
different vector.
Evidence:
src/api/client.ts:38-40, 71-75 (Idempotency-Key set per call).
```

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/context/AuthContext.tsx:91-94, App/zopmop-app/src/api/client.ts:91-93]
[CATEGORY: Auth & Session / 401 handling races signOut]
Finding:
apiFetch fires `_signOut?.()` on any 401 (client.ts:92). AuthContext's
restore() catches 401 from the /me call and calls
`trySilentFirebase()` to attempt recovery (AuthContext.tsx:230-239). But
the /me call inside restore goes through apiFetch — which also calls
_signOut on 401 — racing the local recovery branch. The order works
out today (apiFetch returns the response after invoking _signOut; the
restore() branch then proceeds to delete tokens) but the state
sequence is: _signOut clears UI state → SecureStore deletes succeed →
restore() calls SecureStore.deleteItemAsync again (no-op) → tries
silent refresh → on success, sets new token AND identity. If the user
tapped sign-out in the meantime there's a flash of authenticated UI.
Impact:
Mostly UX. Edge case where simultaneous backgrounding + token-expiry
race produces a brief authenticated frame after the user pressed
Sign Out. Difficult to exploit but the state machine is hard to reason
about.
Fix:
Use a generation counter inside AuthContext that bumps on every signOut.
Silent-refresh success must check the counter before applying state.
Evidence:
src/api/client.ts:91-93, src/context/AuthContext.tsx:230-239.
```

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/screens/auth/OTPVerificationScreen.tsx:107-117]
[CATEGORY: Auth & Session / no timeout on /auth/firebase from OTP screen]
Finding:
The OTP screen calls `fetch(${BASE_URL}/auth/firebase)` directly with NO
AbortController and NO timeout. On a flaky connection the user is
stuck on the spinner until the platform's default network timeout
(iOS ~60s, Android variable). The same issue was previously logged in
AUDIT_2025_2026-05-03.md:198 against the OTP send endpoint at line 105
— still open here for the exchange endpoint.
Impact:
UX. User loses their backend handoff but Firebase has already burned
their OTP attempt → "verification succeeded" UX with no token → stuck.
Fix:
Use apiFetch which has the 10s timeout + retry built in. Or at minimum
mirror the AbortController pattern used in tryFirebaseSilentRefresh
(AuthContext.tsx:77-83).
Evidence:
src/screens/auth/OTPVerificationScreen.tsx:107-117.
```

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/screens/auth/OTPVerificationScreen.tsx:182-187]
[CATEGORY: Auth & Session / dev-only Firebase setting leak risk]
Finding:
`firebaseAuth.settings.appVerificationDisabledForTesting = true;` is
gated on `__DEV__` (line 182). Correct in isolation, but
Hermes/Metro bundle production builds *do* drop `__DEV__` branches —
unless a misconfigured EAS profile (development with production env)
ships. Worth a CI/lint guard.
Impact:
Dev-only assertion failure means real production builds skip Firebase
app-check / reCAPTCHA. Adversary can call /auth/firebase with arbitrary
phone numbers + Firebase test tokens. Critical IF the gate breaks.
Fix:
Add an ESLint rule banning `appVerificationDisabledForTesting` outside
a file in `**/__tests__/**`, or wrap the assignment in a function
that asserts `__DEV__ && Constants.expoConfig?.extra?.allowTestOTP === true`.
Evidence:
src/screens/auth/OTPVerificationScreen.tsx:181-187.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/auth/service.go:99-161]
[CATEGORY: Auth & Session / OTP cooldown — non-atomic check-then-set]
Finding:
SendOTP first checks the lock key via Exists (line 100), then SetNX on
the cooldown key (line 115). Two concurrent SendOTP calls for the same
phone can both observe `locked == 0` and proceed past the lock check.
Only one wins SetNX, but the loser proceeds to `generateSecureOTP` and
`rdb.Set(otpKey, ...)`, overwriting the otp from the winner. SMS not
sent twice (SetNX guards that), but the in-flight OTP races itself.
Already flagged in AUDIT_2025_2026-05-03.md:388 (P2) — STILL OPEN.
Impact:
Tiny window. OTP correctness is preserved (whichever one lands in
Redis last is the valid one). Mostly a race-condition cleanliness
issue.
Fix:
Promote the lock+cooldown check into a single Lua script with both
Exists + SetNX semantics.
Evidence:
internal/auth/service.go:99-145.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/auth/handler.go:330-338]
[CATEGORY: Auth & Session / dev OTP echoed in /auth/send-otp response]
Finding:
When `devOTPEnabled == true` (passed `cfg.IsDevelopment()` at
main.go:258), `/auth/send-otp` echoes the plaintext OTP in the JSON
response body with `note: "OTP included in response for development
only"`. This depends on `Env != production`. If `ENV` is misset on a
staging box that's internet-exposed, the response leaks the OTP.
The IsDevelopment check is centralised so the risk is small.
Impact:
Misconfiguration risk only.
Fix:
Belt-and-braces: add a second gate that requires a non-default value
of an `OTP_ECHO_ALLOWED=1` env var, set only in actual dev. Refuses to
echo even when Env != production unless explicitly enabled.
Evidence:
internal/auth/handler.go:330-338, internal/auth/service.go:74-86,
cmd/api/main.go:258.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/middleware/auth.go:84-87]
[CATEGORY: Auth & Session / cookie fallback in mobile flows]
Finding:
The Authorization header takes precedence; cookie auth is a fallback
(auth.go:84-87). Mobile only ever sends Bearer, but if the
HttpOnly+SameSite=Strict cookie was somehow leaked (unlikely — Strict
prevents cross-site sends), it would still authenticate. CSRF
middleware skips Bearer-bearing requests (csrf.go:42), so a cookie-only
request with no Bearer remains vulnerable to CSRF on
GET-stateless-write endpoints. The Fiber CSRF middleware ALSO skips
certain paths; verify auth endpoints aren't accidentally write-with-no-
CSRF. (Noted by csrf.go:52 — confirmed.)
Impact:
Low. Browser surface is small (admin dashboard hits crm-api, not this
binary).
Fix:
Document explicitly that the cookie path is for browser test clients
only; consider gating it behind Origin/Referer validation.
Evidence:
internal/middleware/auth.go:76-87, internal/middleware/csrf.go:40-50.
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/auth/handler.go:434-461]
[CATEGORY: Auth & Session / OnboardPro role-upgrade gating]
Finding:
OnboardPro correctly does NOT reissue the JWT (handler.go:459) and
does NOT change users.role (repository.go:206-247) until admin
approval. This is the canonical fix for the earlier "self-elevation"
risk. RequireRole("pro") on helper/leave endpoints reads role from
the JWT — so a user whose JWT still says role=customer cannot hit pro
endpoints even if their helpers row is approved. The user must
re-authenticate (OTP again) to get a JWT with role=pro after admin
approval. This is correct, but undocumented — confused devs might
add a "refresh JWT" endpoint later that bypasses re-auth.
Impact:
Currently safe. Documentation gap.
Fix:
Add a comment block on `Service.OnboardPro` explaining the "re-auth
to pick up new role" requirement. Consider a backend-issued
`/me/refresh-jwt` endpoint that re-mints the JWT with the live DB
role (would also help with the suspension-check feature already shipped).
Evidence:
internal/auth/handler.go:434-461, internal/auth/service.go:319-330,
internal/auth/repository.go:206-247.
```

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/context/AuthContext.tsx:307-327]
[CATEGORY: Auth & Session / __guest__ sentinel handling]
Finding:
signIn rejects the `__guest__` sentinel (lines 309-314). Good. But
`apiFetch` will gladly send `Authorization: Bearer __guest__` if any
caller passes the token through (`authHeaders(token)` in api/config.ts).
Defense-in-depth: also reject this token at backend ParseJWTClaims —
currently it would just fail the signature check, which is fine, but
gives the attacker a "yes you're talking to a real server" signal.
Impact:
Negligible.
Fix:
Strip / refuse `__guest__` at the apiFetch layer too.
Evidence:
src/context/AuthContext.tsx:308-314, src/api/config.ts (authHeaders).
```

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/context/AuthContext.tsx:25-30]
[CATEGORY: Auth & Session / 30-day silent-refresh window]
Finding:
FIREBASE_SILENT_REFRESH_WINDOW_MS = 30 days. A device that hasn't
opened the app for 31 days is forced through PhoneEntry. Reasonable
default; matches Firebase's default Phone Auth session lifetime.
Cross-check: Firebase native session can extend indefinitely
under typical defaults — the 30d window is a defense in depth.
Impact:
Informational. No action needed.
Evidence:
src/context/AuthContext.tsx:25, 67-71.
```

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/screens/auth/OTPVerificationScreen.tsx:122-127]
[CATEGORY: Auth & Session / privacy policy acceptance double-write]
Finding:
isNewUser=true + checkbox ticked writes
`AuthStorage.PRIVACY_ACCEPTED_KEY = true` to AsyncStorage AND sends
has_accepted_privacy_policy=true to the backend. If the backend write
succeeds but the AsyncStorage write fails (silently catch'd), the
backend has it but the client doesn't — fine. If the backend exchange
returns non-2xx the user is treated as having accepted (AsyncStorage
set is conditional on the request resolving OK earlier in the same
try block — verified).
Impact:
None observed.
Evidence:
src/screens/auth/OTPVerificationScreen.tsx:122-127.
```

```
[SEVERITY: Nit]
[FILE: App/zopmop-app/src/context/AuthContext.tsx:300]
[CATEGORY: Auth & Session / foreground re-validation never times out]
Finding:
AppState foreground listener calls apiFetch('/me') without an
explicit timeout (the apiFetch wrapper's 10s default applies).
Acceptable. Just calling it out: if the device wakes up on flaky
network the validation hangs for ~10s before either signing out or
silently swallowing the error.
Impact:
UX edge case.
Evidence:
src/context/AuthContext.tsx:292-306.
```

```
[SEVERITY: Nit]
[FILE: App/househelp-api/internal/middleware/admin.go:65-69]
[CATEGORY: Auth & Session / admin_users lookup leaks DB error]
Finding:
AdminMiddleware loads `a.id, a.permissions FROM admin_users WHERE
user_id = $1`. On pgx.ErrNoRows the handler logs the err and returns
403 "insufficient permissions" — correct. But the same code path
returns 403 on any DB error (line 72), masking outages as
authorization failures. A flapping postgres pool would surface to
admins as auth flapping with no actionable error.
Impact:
Operational opacity.
Fix:
Distinguish ErrNoRows (403) from other DB errors (503 with
AUTH_CHECK_FAILED code) — mirror the auth.go pattern.
Evidence:
internal/middleware/admin.go:65-75.
```

---

## Summary tally

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 5 |
| Medium   | 7 |
| Low      | 7 |
| Nit      | 2 |

Total: 21 findings.

## Cross-reference with prior audits

- AUDIT_2025_2026-05-03.md:131-133 — route map confirmed unchanged. No
  newly-unprotected endpoints. Webhook bypass remains the only
  documented exception and is HMAC-authenticated.
- A5-06 chunk 16 (live suspension check) — SHIPPED; current code in
  middleware/auth.go:113-138. New finding: nil-fallback still present.
- AUDIT_2025_2026-05-03.md:388 (OTP cooldown SetNX race) — STILL OPEN
  (downgraded to Low because OTP correctness is preserved).
- AUDIT_2025_2026-05-03.md:198 (no timeout on /auth/firebase from
  OTP screen) — STILL OPEN. Logged here as Medium.
- AUDIT_2025_2026-05-03.md:259-260 (Firebase silent-refresh + signOut)
  — SHIPPED. New finding: double-mint race + raw fetch (no apiFetch).
- AUDIT_2025_2026-05-03.md:430 (FCM mocked when creds missing) — out
  of this subagent's scope; pings to subagent covering Notifications.

## QUESTIONS FOR ADITYA

1. Is server-side JWT revocation in scope for the next sprint, or do you
   want to defer the `token_version` / `jti` work? It's the single
   highest-leverage change in this audit.
2. The `__guest__` sentinel — does any flow actually exercise it any
   more? Couldn't find a callsite that signs in with it. If dead, drop
   it.
3. Are there plans to add a phone-change flow? Right now a user must
   delete their account and re-register, which severs all history. If a
   change-phone is added, the OTP-on-new-number flow needs to invalidate
   all sessions issued under the old phone.
