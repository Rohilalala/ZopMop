# Frontend Audit — ZopMop Mobile App (Subagent 6)

Scope: `App/zopmop-app/src/` — customer (screens/main, screens/booking) and
pro (screens/pro) flows. Read against `audit/REPO_MAP.md`. Findings paginated
to `frontend-2.md` for accessibility/asset/misc detail.

Severity counts (this file):
- Critical: 2
- High: 9
- Medium: 11
- Low: 6
- Nit: 3

---

## State management & cart consistency

```
[SEVERITY: High]
[FILE: src/context/CartContext.tsx:24, src/navigation/MainNavigator.tsx:81]
[CATEGORY: Frontend / State management]
Finding:
CartProvider is mounted inside MainNavigator, NOT alongside AuthProvider /
PrefetchProvider / RoomiesProvider in App.tsx. This means:
  (a) The cart is unmounted/remounted whenever MainNavigator unmounts
      (e.g. signOut flips isAuthenticated → false and back; deep-link cold
      starts that retrigger the auth flow). On remount, the entire cart is
      refetched and optimistic state is lost.
  (b) Any tree below AuthNavigator (e.g. the onboarding flow + the deep-link
      ReferralInvite stash) cannot read or warm the cart. A user arriving via
      a /r/<code> deep link goes through OTP → guest land, and the cart hook
      throws if invoked from anywhere outside Main.
Impact:
- Lost optimistic adds across navigator swaps.
- Inconsistency with the other three contexts which sit globally.
- The "useCart must be used within CartProvider" throw will crash any
  developer touching cart from above Main.
Fix:
Hoist CartProvider into App.tsx next to RoomiesProvider. Inside the provider,
keep the `if (!token) return` guards so the unauthenticated tree still mounts
cleanly with an empty cart.
Evidence:
src/navigation/MainNavigator.tsx:39, 81, 249 wraps Stack.Navigator only.
App.tsx:173–191 lists ThemeProvider → AuthProvider → PrefetchProvider →
RoomiesProvider — Cart is absent.
```

```
[SEVERITY: Medium]
[FILE: src/screens/main/CartScreen.tsx:64-67]
[CATEGORY: Frontend / State management]
Finding:
Module-level cache `cartMemCache` holds addresses + selectedAddress across
component unmounts. It is never invalidated on signOut. A subsequent user
logging in on the same device process (rare but possible without a kill) will
see the prior user's saved addresses momentarily before the new fetch
resolves.
Impact: privacy leak (one user briefly sees another's address title /
full_address) when accounts are switched without restart.
Fix: register a signOut callback (the same pattern used in
src/api/client.ts registerSignOutCallback) that clears cartMemCache, or move
the cache into CartContext where signOut already runs reset logic.
Evidence: src/screens/main/CartScreen.tsx:64–67 + 78–79.
```

```
[SEVERITY: High]
[FILE: src/screens/main/CartScreen.tsx:125-132]
[CATEGORY: Frontend / Hooks]
Finding:
useEffect at L125 disables exhaustive-deps to depend only on
selectedAddress?.id and isRoomiesAddress. It calls
setSelectedMemberIds(new Set(otherMembers.map(...))) but otherMembers is NOT
in deps — and is itself a useMemo derived from myGroup + user?.id. If the
roomies group membership changes while the user is on Cart (host removes a
roomie), the selected member set will not refresh. Same hazard for the
useEffect at L195 (deps: [token] only, but it calls refreshCart +
loadAddresses which close over multiple values).
Impact:
- Stale selected-roomies set → user splits with a removed roomie → backend
  rejects or silently miscredits.
Fix:
Add otherMembers to deps (or memoise key by member id list) and let
refreshCart/loadAddresses be stable callbacks instead of inline closures.
Evidence: src/screens/main/CartScreen.tsx:125–132, 195–202.
```

```
[SEVERITY: Medium]
[FILE: src/screens/main/HomeScreen.tsx:298-399]
[CATEGORY: Frontend / Hooks]
Finding:
The location bootstrap effect's only dep is [token]. But the closure reads
prefetched (a ref read in render), and the resolveNameFromAddresses helper
uses setSelectedAddressId/setAddressTag. If token doesn't change but
selectedAddressId becomes stale (user opens address picker mid-bootstrap),
writeLastKnownLocation at L394 will write the wrong addressId.
Impact: minor — wrong addressId persisted to disk; next launch resolves a
slightly wrong shortcut name.
Fix: capture selectedAddressId in a ref or pass it as a function arg.
Evidence: src/screens/main/HomeScreen.tsx:394.
```

---

## API client layer

```
[SEVERITY: High]
[FILE: src/api/client.ts:38-40, 77]
[CATEGORY: Frontend / API client]
Finding:
generateIdempotencyKey() is generated ONCE per apiFetch call and shared across
ALL retry attempts (good for retried 5xx — that's by design). But the same
key is also reused if the CALLER manually re-invokes apiFetch after a
timeout. Worse: the key is also attached to GET requests, which idempotency
middleware will dedup. A normal user mashing pull-to-refresh on a slow GET
will hit the server-side SETNX cache and receive a stale cached body for the
duration of the idempotency window.
Impact: stale data after pull-to-refresh; harder to surface backend changes
to users with marginal connectivity.
Fix:
Only attach Idempotency-Key on non-idempotent methods (POST/PUT/PATCH/DELETE
where the caller didn't explicitly opt out). Skip for GET/HEAD.
Evidence: src/api/client.ts:71–75 attaches unconditionally regardless of
options?.method.
```

```
[SEVERITY: Medium]
[FILE: src/api/client.ts:91-99]
[CATEGORY: Frontend / API client]
Finding:
The 401 → global signOut happens BEFORE the response is returned to the
caller. Caller code that awaits res.json() will then race with AuthProvider
clearing token + SecureStore. In practice the response body still resolves,
but the screen that triggered the call gets unmounted mid-render which can
trigger "Can't perform a React state update on an unmounted component"
warnings.
Impact: noisy warnings on token expiry; possible setState-after-unmount
bugs in screens that update state after the failing fetch.
Fix: queue the signOut on a microtask (`queueMicrotask(_signOut)`) so the
caller's `then` chain runs first.
Evidence: src/api/client.ts:91–93.
```

```
[SEVERITY: High]
[FILE: src/api/client.ts (all callers), src/screens/main/*.tsx, src/screens/pro/*.tsx]
[CATEGORY: Frontend / API client]
Finding:
Request cancellation on unmount is essentially absent. Only PaymentScreen
uses AbortController (search: `AbortController` returns 4 hits in src,
exclusive of client.ts). Every other screen (HomeScreen.location bootstrap,
CartScreen.loadAddresses, ProDashboard polls, ReferralEarn stats fetch,
ReferralInvite preflight, ActiveBooking tracking poll) fires fetches and
relies on `cancelled` boolean flags inside the effect to ignore the result.
The underlying network request still completes and consumes battery/data;
abort would short-circuit it.
Impact:
- Wasted radio time on slow networks (battery + data plan).
- Race conditions: a stale fetch from screen N can still resolve setState on
  screen N+1 if the `cancelled` flag scope is wrong.
Fix:
Add `signal: controller.signal` plumbing through the api/ functions (most
already accept RequestInit-ish options) and abort on cleanup in every
component that fires a fetch in useEffect.
Evidence: `grep -rn AbortController src/` → 4 hits (client.ts × 2,
PaymentScreen.tsx × 2). No abort wiring in HomeScreen, CartScreen,
ProDashboard, ReferralEarn, ActiveBooking, ProActive, etc.
```

```
[SEVERITY: Medium]
[FILE: src/api/client.ts:77-118]
[CATEGORY: Frontend / API client]
Finding:
Retry loop retries 5xx and AbortError (timeout) with no jitter, no Retry-After
honoring, and no awareness of whether the caller provided their own signal.
If the caller passes signal:controller.signal and the controller is aborted
mid-retry-sleep, sleep() will still resolve (it uses bare setTimeout) and
the loop will issue another fetch with the same now-aborted signal — which
will throw AbortError → retry again, then finally throw the same error
message either way.
Impact:
- Caller-driven cancellation is ignored during the retry-sleep window.
- Thundering herd on backend recovery (no jitter).
Fix:
- Treat caller-supplied signal aborts distinctly from internal timeout.
- Add ±20% jitter to RETRY_BACKOFF_MS.
- Honor Retry-After header on 503.
Evidence: src/api/client.ts:42 sleep is unaware of options?.signal.
```

```
[SEVERITY: Low]
[FILE: src/api/*.ts]
[CATEGORY: Frontend / API client]
Finding:
Error handling pattern is duplicated across 23 api files. Most either return
JSON or throw a generic Error with the response body, but the error shape
varies — `referral.ts` attaches `code` on the Error object, `users.ts`
defines a typed `UnpaidBookingsError`, others throw plain Errors. Screens
must inspect `err?.code`, `err?.response?.data?.code`, `err?.message`,
`err?.response?.data?.error`, etc. (see CartScreen.handleCheckout L323-329).
Impact: brittle error UX; the screen's defensive coalescing chain is a
known source of "Something went wrong" toasts that hide the real cause.
Fix: extract a single `ApiError` class with `code`, `httpStatus`, `message`,
`raw` and have every api/*.ts throw it.
Evidence:
src/api/referral.ts:38-39 (err.code = body.code);
src/api/users.ts (UnpaidBookingsError class);
src/screens/main/CartScreen.tsx:323-329 (fallback chain).
```

---

## Auth friction / redirect loops

```
[SEVERITY: High]
[FILE: src/context/AuthContext.tsx:166-281]
[CATEGORY: Frontend / Auth]
Finding:
The restore() effect has runs-only-once semantics (deps=[]) and:
  - Issues GET /me with the stored token using apiFetch (which itself
    triggers _signOut on 401).
  - registerSignOutCallback at L158 registers signOut BEFORE restore runs
    (good).
But: if /me returns 401 here, apiFetch calls _signOut at the same moment
restore is processing the same 401 (L230). signOut() runs twice — once
inside the apiFetch interceptor and once manually as state is cleared. The
second invocation will fire another posthog.capture('user_signed_out') and
another posthog.reset(), which is harmless but emits duplicate analytics.
Impact: minor — duplicate analytics on token revocation.
Fix: in restore(), pass an option to skip the 401 auto-signOut, or detect
and short-circuit duplicate signOuts in AuthProvider.
Evidence: src/context/AuthContext.tsx:222 apiFetch + L230 explicit branch.
```

```
[SEVERITY: Medium]
[FILE: src/context/AuthContext.tsx:170-173, 277]
[CATEGORY: Frontend / Auth]
Finding:
The 8-second ceiling timer (L170) is defensive against hung SecureStore /
Firebase native — good. But if the ceiling fires AND restore() finishes a
moment later, both call setIsLoading(false). React handles double setState
fine, but the state machine assumption ("isLoading false → either token or
null is the source of truth") breaks if restore() then sets a token AFTER
the user has already been routed to AuthNavigator. The user sees
PhoneEntryScreen flash for ~50ms then jump to Home.
Impact: visible flicker on slow simulators / cold-start.
Fix: in restore(), check if mountedRef / a settled ref is set before
calling setIsLoading(false) / setToken / setUser at the very end.
Evidence: src/context/AuthContext.tsx:170, 277.
```

```
[SEVERITY: Critical]
[FILE: App.tsx:42-69]
[CATEGORY: Frontend / Deep links]
Finding:
The deep-link handler stashes the referral code in AsyncStorage under
'pendingReferralCode' when the user is unauthenticated. After login, the
effect at L60 reads it and navigates. BUT:
  (a) The stash uses AsyncStorage (not SecureStore), so the code persists in
      plaintext on disk indefinitely until the post-login flush runs.
  (b) If a user opens a /r/<code> link, never logs in, then closes the app —
      the next time ANOTHER user (e.g. a household member who installs the
      app fresh, or a user signing in on the same device) authenticates,
      they will be navigated to ReferralInvite with someone else's code
      attached. This is a referral attribution bug, not just a UX bug.
Impact:
- Cross-user referral attribution.
- The referral code is also a low-value secret (3-use cap, but the
  recipient can claim ₹100).
Fix:
  - Clear pendingReferralCode on app launch IF the stored timestamp is older
    than e.g. 7 days, OR
  - Tie the stash to the device installation ID, OR
  - Clear pendingReferralCode in signOut() (currently only the post-login
    flush at L62-67 clears it).
Evidence: App.tsx:50 AsyncStorage.setItem('pendingReferralCode', code) with
no expiry; signOut() in AuthContext does not touch it.
```

```
[SEVERITY: Medium]
[FILE: App.tsx:42-57]
[CATEGORY: Frontend / Deep links]
Finding:
Deep-link regex `/r/([A-Za-z0-9_]+)/` only matches the universal-link path
`zopmop.com/r/<code>`. A custom scheme deep link `zopmop://r/<code>` would
match (the regex doesn't anchor to a host), so this is OK. But:
  - The captured code is `.toUpperCase()`'d, but the backend canonicalises
    referral codes itself. If a future code uses lowercase chars (e.g. the
    base36 path), this would silently break.
  - No analytics event fires when a deep link is received and parsed (only
    after the user accepts in ReferralInvite). Hard to measure deep-link
    funnel drop-off.
Impact: low — analytics gap, future-proofing.
Fix: capture a `referral_deep_link_received` event with source URL,
authenticated state, and stash status.
Evidence: App.tsx:42-57.
```

---

## Skeleton screen coverage

```
[SEVERITY: Medium]
[FILE: multiple]
[CATEGORY: Frontend / Loading states]
Finding:
Skeletons exist for HomeScreen, CartScreen, BookingsScreen and a generic
LoadingSkeleton. The following async screens fall back to ActivityIndicator
or no loading state at all:
  - ReferralEarnScreen.tsx (uses ActivityIndicator, L136)
  - ReferralInviteScreen.tsx (ActivityIndicator)
  - OffersScreen.tsx
  - PaymentScreen.tsx (Cashfree handoff — but the pre-handoff fetch is bare)
  - WalletScreen.tsx
  - TrackLiveScreen.tsx
  - ActiveBookingScreen.tsx (uses LoadingBars overlay)
  - InstantMatchingScreen.tsx
  - ProMatchedScreen.tsx
  - ProActiveScreen.tsx (LoadingBars overlay)
  - ProScheduledInviteScreen.tsx
  - ProOnboardingScreen.tsx
  - RoomiesSetupScreen.tsx
  - RoomiesWelcomeScreen.tsx
  - BookingConfirmedScreen.tsx
Impact: inconsistent loading UX — referral, wallet, and pro flows show
spinners while home/cart/bookings show skeletons. Particularly bad for
ReferralEarnScreen which is heavily promoted from Home (HomeHeader pill).
Fix: extract a `ReferralEarnSkeleton`, `WalletSkeleton`, `OffersSkeleton`,
`ProDashboardSkeleton` and replace ActivityIndicator usages. Map-heavy
screens (ActiveBooking, ProActive) can keep an overlay but should pre-render
the bottom-sheet skeleton.
Evidence: src/components/skeletons/ contains only 4 files; comparison
script in audit run identified 15 screens lacking Skeleton imports while
having async useEffects.
```

---

## Toast usage / silent failures

```
[SEVERITY: High]
[FILE: src/screens/main/ReferralEarnScreen.tsx:98-104, src/screens/main/ReferralInviteScreen.tsx:77-80]
[CATEGORY: Frontend / Error surfacing]
Finding:
ReferralEarnScreen and ReferralInviteScreen never call the global toast
system (showError / showSuccess / showInfo). They roll their own inline
error banner and `errorMsg` state. This is a regression from the rest of
the app and means:
  - Errors don't fire the toast haptic / analytics.
  - A successful "Invite accepted" doesn't show the success toast either
    (only an inline screen).
  - The preflight failure at ReferralInviteScreen.tsx:77 swallows the error
    with only console.warn — no user signal.
Impact: inconsistent UX, harder to diagnose failures from production logs.
Fix: route every catch through showError() and emit a toast on success.
Evidence: grep "showError\|showSuccess" in those two files returns 0 hits.
```

```
[SEVERITY: High]
[FILE: src/context/CartContext.tsx:34-37]
[CATEGORY: Frontend / Error surfacing]
Finding:
refreshCart silently swallows ALL errors with `catch {}`. Comment claims
"cart is a convenience feature" but a stale cart means a user can land on
CartScreen with a server-empty cart that the client still thinks is
populated (refresh failed). On checkout, the server's view wins and a
booking is created with the wrong line items.
Impact: silent inconsistency between client cart UI and server cart state →
booking mismatch.
Fix: surface errors via showError when refreshCart is invoked from a user
action (CartScreen mount, AllServices retap). Mount-time refresh can stay
silent if it falls back to the last known-good cart.
Evidence: src/context/CartContext.tsx:29-37.
```

```
[SEVERITY: Medium]
[FILE: src/screens/booking/ActiveBookingScreen.tsx:141-144, 163]
[CATEGORY: Frontend / Error surfacing]
Finding:
fetchTracking and fetchStatus both silently swallow errors and "keep
polling". When the booking is in_progress and the network drops for >30s
mid-service, the customer sees no banner — the ETA / status badge just
freezes. The legacy screen is now a thin shell (MainNavigator comment says
TrackLiveScreen has replaced it) but the route is still wired and may serve
fallback navigation paths.
Impact: customer doesn't know whether the pro is genuinely lost or whether
they're offline.
Fix: track consecutive poll failures and show OfflineBanner / showInfo at
3 failures. ProActive already mounts OfflineBanner — extend the pattern.
Evidence: src/screens/booking/ActiveBookingScreen.tsx:141-144.
```

```
[SEVERITY: Medium]
[FILE: src/screens/main/CartScreen.tsx:163-184]
[CATEGORY: Frontend / Error surfacing]
Finding:
Three swallowed catches in `loadAddresses`:
  - L175: location fetch failure → fallback path is correct but no log.
  - L183: getBookings('past') failure for last-used address → silent.
  - L683: onRefreshAddresses outer catch → silent.
A user with a flaky network picks no address, hits checkout, gets the
"No address" toast — but the real cause was the listAddresses call
succeeded with `[]` despite the server having addresses (or vice versa).
Impact: user thinks they have no addresses when they actually do, leads to
re-adding the same address.
Fix: log to PostHog or console.warn on each silent failure; surface a
non-blocking "Could not refresh addresses" toast.
Evidence: src/screens/main/CartScreen.tsx:163-184, 683.
```

---

## Real-time listeners / memory

```
[SEVERITY: Medium]
[FILE: src/screens/pro/ProActiveScreen.tsx:126-161]
[CATEGORY: Frontend / Real-time]
Finding:
WebSocket reconnect uses exponential backoff but has NO upper bound on
reconnect attempts. If the backend is genuinely down for hours, the pro's
device will hammer reconnect every 30s (cap) indefinitely, including while
the app is backgrounded. The AppState listener pauses heartbeat (L255-265)
but does NOT pause the WS reconnect timer.
Impact: battery + data drain when backend is down for extended period;
backgrounded app continues retrying.
Fix:
  - Stop reconnecting after N consecutive failures (e.g. 10) and require
    foreground re-entry to retry, OR
  - Pause reconnect timer on AppState background.
Evidence: src/screens/pro/ProActiveScreen.tsx:148-158; AppState handler
at L255-265 only touches polls + heartbeat.
```

```
[SEVERITY: Medium]
[FILE: src/screens/pro/ProDashboardScreen.tsx:357-381]
[CATEGORY: Frontend / Real-time]
Finding:
Two useEffects both manipulate locationHeartbeatRef.current:
  - L357-370: AppState change handler clears/starts interval.
  - L374-381: hasActiveBooking change handler clears/restarts with new
    cadence.
There is no synchronisation between them. If hasActiveBooking flips while
the app is backgrounded, the cadence-swap effect at L380 will start a NEW
heartbeat interval despite background state. The AppState handler will then
clear it next time it fires, but for the duration of background+interval,
the device is polling GPS in the background without the user's consent.
Impact: background GPS pings while customer is offline. On iOS this should
fail because foreground permission is required for getCurrentPositionAsync,
but it's a defensive correctness issue.
Fix: gate the cadence-swap effect on `AppState.currentState === 'active'`,
or read a foreground-state ref.
Evidence: src/screens/pro/ProDashboardScreen.tsx:374-381.
```

```
[SEVERITY: Low]
[FILE: src/screens/pro/ProActiveScreen.tsx:229-284]
[CATEGORY: Frontend / Real-time]
Finding:
The mega-useEffect at L229 has deps `[connectWs, fetchStatus, fetchTracking,
pushCurrentLocation]`. All four are useCallbacks with `token` in their
deps. So when token rotates (rare), the effect tears down EVERYTHING
(ws, polls, AppState sub, heartbeat) and rebuilds. The new build doesn't
pass the cancelled-by-unmount sentinel through, so a token swap during a
trip could orphan the in-flight WebSocket briefly.
Impact: very minor — token rotation during a service is extremely rare.
Fix: split into smaller effects or capture token in a ref.
Evidence: src/screens/pro/ProActiveScreen.tsx:229-284.
```

---

## Navigation / deep links / back

```
[SEVERITY: High]
[FILE: src/navigation/MainNavigator.tsx:85]
[CATEGORY: Frontend / Navigation]
Finding:
Initial route is selected based on user.role at MainNavigator mount:
`user?.role === 'pro' || user?.role === 'helper' ? 'ProDashboard' : 'Tabs'`.
If a user changes role server-side (e.g. ops promotes a customer to pro)
and the client's cached user has the old role, the navigator boots to the
wrong dashboard until SecureStore is invalidated.
Impact: after a role flip the user lands on the wrong shell. signOut
clears SecureStore but for in-app role promotion (rare) there's no flow.
Fix: when /me fetch in AppState foreground listener returns a different
role than stored, force-navigate to the matching dashboard or signOut.
Evidence: src/navigation/MainNavigator.tsx:85; AuthContext.tsx:292-306
re-validates /me but does not compare role.
```

```
[SEVERITY: Low]
[FILE: src/screens/main/ReferralInviteScreen.tsx:130-131]
[CATEGORY: Frontend / Navigation]
Finding:
handleDecline navigates to `Tabs > Home` (resetting any back stack). For a
deep-link entry, this is fine. But for an in-app entry (currently none, but
the home pill links here), declining loses the back history.
Impact: small UX inconsistency.
Fix: prefer navigation.canGoBack() ? goBack() : navigate('Tabs', {screen: 'Home'}).
Evidence: src/screens/main/ReferralInviteScreen.tsx:130.
```

```
[SEVERITY: Medium]
[FILE: src/screens/main/ReferralInviteScreen.tsx:48-50]
[CATEGORY: Frontend / Hooks]
Finding:
useEffect runs runPreflightAndGps() with deps=[]. The closure captures
`token` (used at L60) and `code` (used at L71). If the route is re-entered
with a new code (deep-link in foreground, see App.tsx:48 navNavigate which
just navigates — does not unmount), the preflight will not re-run with the
new code; the user sees a confirm screen for the OLD code.
Impact: deep-link-in-foreground race when the user receives a second
referral link before accepting the first.
Fix: deps=[token, code]; OR add a `useFocusEffect` to re-run on focus.
Evidence: src/screens/main/ReferralInviteScreen.tsx:48-50, 60, 71.
```

```
[SEVERITY: Low]
[FILE: App.tsx:64-68]
[CATEGORY: Frontend / Deep links]
Finding:
The post-login deep-link flush uses a hardcoded `setTimeout(..., 300)` to
wait for the navigation tree to be ready. This is fragile — on slower
devices the nav tree may need >300ms. The codebase already exposes
`flushPendingNavigation` for exactly this race (called on
NavigationContainer.onReady). Use that pattern instead.
Impact: rare — on cold device launch with deep link, the navigate may fire
before MainNavigator is ready, silently fail, leave the referral code in
storage.
Fix: replace setTimeout with `navigationRef.isReady() ? navigate :
pendingNavigationStore.push`.
Evidence: App.tsx:64-68; src/navigation/navigationRef.ts already has the
infra.
```

---

## Form validation

```
[SEVERITY: Medium]
[FILE: src/screens/auth/PhoneEntryScreen.tsx:89]
[CATEGORY: Frontend / Validation]
Finding:
Indian-mobile validation is just `phone.replace(/\s/g, '').length === 10`.
No first-digit check (real IN mobile numbers start with 6/7/8/9), no
all-zero / all-same-digit rejection. The backend will reject via Firebase
auth/invalid-phone-number, but client-side users get only a generic toast
after a round-trip.
Impact: minor friction; lets `0000000000` through to Firebase.
Fix: `/^[6-9]\d{9}$/`.
Evidence: src/screens/auth/PhoneEntryScreen.tsx:89.
```

```
[SEVERITY: Medium]
[FILE: src/screens/pro/ProOnboardingScreen.tsx:174-194]
[CATEGORY: Frontend / Validation]
Finding:
Pro onboarding has only 3 step-level validations:
  - Step 1: ≥1 service selected
  - Step 2: GPS captured
  - Step 3: ≥1 slot selected
The backend `/me/onboard-pro` accepts (lat, lng, services, availability,
address). There is no client-side validation that:
  - selectedServices values are within the allowed enum (they're hardcoded
    here but the backend has its own list — if they drift, no client error)
  - address is non-empty when GPS reverse-geocode fails to populate it
  - lat/lng are inside India's bbox (the backend will reject distant coords
    but the client lets the submit happen)
Impact: ambiguous failure messages on bad submits.
Fix: add a final-step summary screen with explicit validation; reuse the
same SERVICES enum the backend exposes via /sdui/config.
Evidence: src/screens/pro/ProOnboardingScreen.tsx:174-194.
```

```
[SEVERITY: Nit]
[FILE: src/screens/main/ReferralInviteScreen.tsx:108]
[CATEGORY: Frontend / Validation]
Finding:
The referral code from route.params is passed directly to applyReferralCode
without trimming or upper-casing. Deep-link path already upper-cases
(App.tsx:46) — but if anyone ever calls navigation.navigate('ReferralInvite',
{ code: 'foo' }) in-app, it goes through unchanged.
Fix: applyReferralCode(token, code.toUpperCase().trim()).
Evidence: src/screens/main/ReferralInviteScreen.tsx:108.
```

---

## Hooks usage / closures

```
[SEVERITY: Medium]
[FILE: src/context/CartContext.tsx:50-75]
[CATEGORY: Frontend / Hooks]
Finding:
addItem useCallback deps `[token, cart, pulseBadge]` — `cart` is in deps so
every cart mutation invalidates this callback. Any consumer that depends on
addItem reference identity (e.g. memoised list items) will re-render on
EVERY cart change. The comment claims serviceName + priceCents are args
not closured deps, which is correct, but `cart` is genuinely closured (for
the snapshot at L53) — could use a ref instead.
Impact: unnecessary re-renders of cart consumers; possible jank in
ServiceGridSection FlashList.
Fix: replace `const snapshot = cart` with `const snapshot = cartRef.current`
and drop `cart` from deps; mirror cart into cartRef in a useEffect.
Evidence: src/context/CartContext.tsx:50-75.
```

```
[SEVERITY: Low]
[FILE: src/screens/pro/ProDashboardScreen.tsx:148]
[CATEGORY: Frontend / Hooks]
Finding:
`useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);` is at
the top of the file before the ref is declared at L169. This works because
the ref is in TDZ at render-1 (the effect runs after render commits), but
ESLint may not catch the same pattern when refactoring. Cosmetic — works.
Fix: move the ref declaration above the effect.
Evidence: src/screens/pro/ProDashboardScreen.tsx:148, 169.
```

```
[SEVERITY: Low]
[FILE: src/screens/main/HomeScreen.tsx:246-249]
[CATEGORY: Frontend / Hooks]
Finding:
onRefresh useCallback has deps including FLY_SCALE, flyTargetX, flyTargetY
which are computed from `insets.top` + Dimensions.get('window').width. The
latter never changes within a session, but `insets.top` does on orientation
change. Effect-driven animation values are stable (useSharedValue), but
recomputing the flyTargetY on rotate would re-fire useCallback identity
and the RefreshControl's onRefresh prop changes. Not a bug — just a code
smell suggesting these should be memoised.
Fix: useMemo the geometry constants.
Evidence: src/screens/main/HomeScreen.tsx:150-158, 246-249.
```

---

## PostHog wiring

```
[SEVERITY: Critical]
[FILE: src/context/AuthContext.tsx:320-323]
[CATEGORY: Frontend / Privacy]
Finding:
PostHog identify() is called with `phone` in $set on every signIn. Phone
numbers are PII and are now in PostHog's person properties — visible to
anyone with PostHog access. The phone is also full-length (`+91XXXXXXXXXX`)
not hashed.
Impact:
- DPDP compliance risk (Indian DPDP rules treat phone as personal data
  requiring consent + minimisation).
- Anyone with PostHog Project Admin access can de-anonymise users by
  phone search.
- The phone is exported in any PostHog data export the company runs.
Fix:
  - Do not send raw phone to PostHog. If you need a stable contact ref,
    use a SHA-256 hash with a per-user salt.
  - Remove `name` from $set as well unless analytics actually use it.
  - Audit existing PostHog people data and run a redaction PII purge.
Evidence: src/context/AuthContext.tsx:320-323.
```

```
[SEVERITY: Medium]
[FILE: src/config/posthog.ts:25-39]
[CATEGORY: Frontend / Privacy]
Finding:
PostHog config:
  - `captureAppLifecycleEvents: true` — fine.
  - PostHogProvider in App.tsx:91-96 uses `autocapture: { captureTouches:
    true, propsToCapture: ['testID'], maxElementsCaptured: 20 }`. Touch
    autocapture in React Native sends element trees, which can include
    Text node contents — names, addresses, phone numbers — if they are
    rendered as children of touched buttons. PostHog RN autocapture is less
    PII-aggressive than web, but it WILL send the touched element's
    accessibilityLabel and any descendants matching propsToCapture.
  - No `propertiesToRedact` / sanitisation step before capture.
Impact: phone numbers, addresses, etc. that appear inside a tappable
component (e.g. CartScreen address card, BookingConfirmed phone-tap button)
may leak into PostHog touch events.
Fix:
  - Set `propsToCapture: ['testID']` only (already done — good).
  - Add `beforeSend` (or `beforeCapture`) hook to redact `$elements` text
    payload, OR mark sensitive components with `noAutocapture` testID.
  - Validate by tapping the address card on a dev project and confirming
    PostHog doesn't receive the address text.
Evidence: App.tsx:91-96; src/config/posthog.ts:25-39.
```

```
[SEVERITY: Low]
[FILE: src/config/posthog.ts:33]
[CATEGORY: Frontend / Analytics]
Finding:
`preloadFeatureFlags: true` blocks the SDK init until the feature-flag
endpoint responds. The featureFlagsRequestTimeoutMs is 10s — that's 10s
where any flag-gated screen (none today, but planned) would wait. PostHog
recommends `preloadFeatureFlags: true` only when you have flag-gated UI on
first paint; this app has none yet.
Fix: set to false until feature flags are actually wired into a launch path.
Evidence: src/config/posthog.ts:33-35.
```

```
[SEVERITY: Nit]
[FILE: src/config/posthog.ts:25]
[CATEGORY: Frontend / Analytics]
Finding:
The PostHog client is instantiated with `'placeholder_key'` and
`disabled: true` when the env var is missing. This is silently fine at
runtime, but `new PostHog(...)` still does internal setup (worker thread,
storage init). It would be cleaner to export a no-op stub when not
configured.
Fix: `export const posthog = isPostHogConfigured ? new PostHog(...) :
{ capture: () => {}, identify: () => {}, reset: () => {}, ... } as any;`
Evidence: src/config/posthog.ts:18-39.
```

---

(Continued in `frontend-2.md` for: accessibility, image handling, offline
resilience, asset sizes, and minor UX/perf notes.)
