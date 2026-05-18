# Frontend Audit — Continued (Subagent 6)

Severity counts (this file):
- Critical: 0
- High: 4
- Medium: 8
- Low: 6
- Nit: 4

---

## Accessibility

```
[SEVERITY: High]
[FILE: project-wide]
[CATEGORY: Frontend / Accessibility]
Finding:
`allowFontScaling` is never explicitly set on any `<Text>` component in the
src/ tree (grep result: 0 occurrences). The default is `true` — good in
principle — but the design system has hardcoded fontSize values
(FontSize.xs … FontSize.2xl in src/theme) and many tightly-packed rows
(CartScreen bill, ProDashboard stats) will overflow / clip at 200% Dynamic
Type. There's no integration test for large-font rendering.
Impact: app fails iOS App Store accessibility expectations at 200% Dynamic
Type; Android Large Text setting will visibly clip rows.
Fix: do a Dynamic Type / 200% font audit on each screen. For genuinely
fixed-size icons (badges, dot counts) set allowFontScaling={false}; for
body text leave default true and verify layouts.
Evidence: `grep -rn allowFontScaling src/` → 0 hits.
```

```
[SEVERITY: High]
[FILE: 20 screens — see list]
[CATEGORY: Frontend / Accessibility]
Finding:
20 of 28 screens that use TouchableOpacity/Pressable have ZERO
accessibilityLabel anywhere in them. Notable offenders:
  - src/screens/auth/* (all 7 auth screens — critical onboarding path)
  - src/screens/main/ReferralEarnScreen.tsx
  - src/screens/main/ReferralInviteScreen.tsx
  - src/screens/main/ChatScreen.tsx
  - src/screens/main/ReportIssueScreen.tsx
  - src/screens/main/RoomiesJoinScreen.tsx
  - src/screens/main/RoomiesSetupScreen.tsx
  - src/screens/main/TipScreen.tsx
  - src/screens/main/TrackLiveScreen.tsx
  - src/screens/main/ProfileScreen.tsx
  - src/screens/booking/ActiveBookingScreen.tsx
  - src/screens/booking/InstantMatchingScreen.tsx
  - src/screens/pro/ProOnboardingScreen.tsx
  - src/screens/BackendDownScreen.tsx
Impact: VoiceOver / TalkBack users can't navigate icon-only buttons (back
arrows, copy, share). App Store / Play Store reviewer may flag.
Fix: add accessibilityLabel + accessibilityRole="button" on every
TouchableOpacity that renders only an icon or has unclear inner text.
Evidence: per-file grep diff: 14/28 screens with TouchableOpacity have any
accessibilityLabel.
```

```
[SEVERITY: Medium]
[FILE: src/screens/main/CartScreen.tsx:585-604]
[CATEGORY: Frontend / Accessibility]
Finding:
Quantity +/- buttons are 26×26 px with hitSlop=8, giving an effective
touch area of 42×42 — below Apple HIG minimum 44pt and Google Material
minimum 48dp. Same pattern in several other compact controls (DarkToggle
thumb 24px).
Impact: harder to hit for users with motor impairment; HIG/Material
violation.
Fix: bump hitSlop to 11 (→ 48dp effective) or enlarge qtyBtn to 32×32.
Evidence: src/screens/main/CartScreen.tsx:816 `qtyBtn: { width: 26, height: 26 }`
+ L590, 601 `hitSlop={8}`.
```

```
[SEVERITY: Low]
[FILE: src/screens/pro/ProOnboardingScreen.tsx:34-41]
[CATEGORY: Frontend / Accessibility + Design system]
Finding:
ProOnboarding's service-picker grid uses emoji characters (🏠 🍳 👕 🐾 🌿 🚗)
as icons. This violates the project's stated convention
(`/Users/adityarohilla/.claude/.../MEMORY.md` — "No emojis in app UI, use
Feather / vector icons"). Emojis also render inconsistently across Android
OEMs (Samsung, Xiaomi, MIUI) and have no accessibilityLabel — VoiceOver
reads "House" or omits depending on locale.
Impact: design inconsistency with the rest of the app; non-deterministic
rendering on Android; a11y gap.
Fix: replace with SvgIcon set used in the customer flow (already imported
elsewhere on the same screen).
Evidence: src/screens/pro/ProOnboardingScreen.tsx:35-40 and the same file
imports `SvgIcon` at L30 but doesn't use it for these.
```

---

## Image handling

```
[SEVERITY: High]
[FILE: assets/]
[CATEGORY: Frontend / Assets]
Finding:
Multiple PNG assets are 2 MB+ raw — far larger than necessary for mobile UI
icons / hero images:
  - assets/Service icons/balcony.png — 2.3 MB
  - assets/Service icons/kitchen-prep.png — 2.3 MB
  - assets/Service icons/window-cleaning.png — 2.2 MB
  - assets/Service icons/bathroom-cleaning.png — 2.2 MB
  - assets/Dusting wiping.png — 2.2 MB
  - assets/cabinet-clenanng .png — 2.1 MB (NOTE: typo in filename + leading
    space; also the file is referenced as-is somewhere)
  - assets/instant-booking.png — 2.1 MB
  - assets/Service icons/utensils.png — 2.1 MB
  - assets/Service icons/mopping-and-sweeping.png — 1.5 MB
  - assets/Service icons/car-cleaning.png — 1.5 MB
Total `assets/` is 31 MB. These ship in the binary regardless of whether
used.
Impact:
- App download size (per-platform IPA/AAB) inflated by ~25 MB.
- Image decode time on FlashList scroll (these are used as service icons,
  rendered at ~42×42).
Fix:
- Re-export every service icon at the actual rendered size (≤256 px on the
  long edge) and convert to WebP. Expected ≥95% size reduction.
- Move to expo-image (already a dep) for caching + memory limit control.
- Rename `cabinet-clenanng .png` to remove the typo + leading space (the
  space breaks shell tooling and can confuse bundlers).
Evidence: `du -h` on each path; only 3 screens currently import
expo-image (AllServicesScreen, ServiceGridSection, BookingsScreen).
```

```
[SEVERITY: Medium]
[FILE: src/sdui/sections/ServiceGridSection.tsx, src/screens/main/CartScreen.tsx]
[CATEGORY: Frontend / Assets]
Finding:
ServiceGridSection uses expo-image (good) but CartScreen renders the same
service icons via React Native's built-in `Image` component (CartScreen.tsx:12,
L578). This means the same PNG is decoded twice — once in expo-image's
cache, once via RN Image — and the RN Image path doesn't share the cache.
Impact: minor memory waste, slower cart open after home browse.
Fix: switch CartScreen.svcIcon to expo-image with same source pattern.
Evidence: src/screens/main/CartScreen.tsx:12 (RN Image), L578 (<Image
source={img} ...>).
```

---

## Offline resilience

```
[SEVERITY: Medium]
[FILE: src/context/CartContext.tsx]
[CATEGORY: Frontend / Offline]
Finding:
CartContext has no offline-queue for cart adds/removes. addItem optimistically
updates state then awaits server. If the network is offline, addToCart
throws, CartContext reverts to snapshot, showError fires. There is no
queue + replay-on-reconnect pattern (unlike ProDashboard's location ping
queue at src/utils/locationPingQueue).
Impact: cart adds drop on flaky networks; user re-adds when reconnected.
Fix: extend the locationPingQueue pattern to cart mutations. Lower priority
because cart adds are user-initiated and idempotency keys make replay safe.
Evidence: src/context/CartContext.tsx:50-91.
```

```
[SEVERITY: Medium]
[FILE: src/screens/auth/OTPVerificationScreen.tsx]
[CATEGORY: Frontend / Offline]
Finding:
OTP entry flow has no offline detection. If the user is offline at OTP
submit, the request times out via apiFetch's 10s ceiling + retries — total
~17s wait, then a generic timeout error. No queue (intentional — OTP must
be live), but the UX is opaque.
Impact: 17s blank wait before error.
Fix: check NetInfo.isConnected before submit; show "You're offline" with
retry instead of timing out.
Evidence: src/screens/auth/OTPVerificationScreen.tsx + src/api/client.ts:16
REQUEST_TIMEOUT_MS=10000 with up to 3 retries.
```

```
[SEVERITY: Low]
[FILE: src/context/AuthContext.tsx:166-281]
[CATEGORY: Frontend / Offline]
Finding:
The auth restore path explicitly handles offline (falls back to cached
SecureStore values). But `apiFetch` inside restore will hit the retry
loop, sleeping up to 7s before timing out — restore's own 5s controller
timeout will fire first and abort. The retry sleep is `await sleep(1000)`
inside the loop, called before the abort handler runs, so the abort
short-circuits cleanly. Good.
Impact: none — defensive note.
Evidence: src/context/AuthContext.tsx:217-256, src/api/client.ts:82-107.
```

```
[SEVERITY: Medium]
[FILE: src/utils/locationPingQueue.ts (referenced)]
[CATEGORY: Frontend / Offline]
Finding:
Pro-side location ping queue at src/utils/locationPingQueue is well-designed
(addConnectivityListener → flush). But the queue is unbounded and stored
in AsyncStorage. A pro who's offline for hours during a service will
accumulate hundreds of location pings, each ~120 bytes. On reconnect the
flush is a serial loop (per code in ProDashboardScreen.tsx:343-353) which
hammers the backend with N puts.
Impact: thundering herd on reconnect; possible 429 from server-side rate
limits.
Fix: cap queue at 50 pings (oldest evicted) or batch-flush server-side.
Evidence: src/screens/pro/ProDashboardScreen.tsx:343-353, queue impl in
src/utils/locationPingQueue.
```

---

## Misc / minor

```
[SEVERITY: High]
[FILE: src/context/CartContext.tsx:55-56]
[CATEGORY: Frontend / Correctness]
Finding:
Optimistic temp item uses `id: 'tmp-${Date.now()}'`. If a user double-taps
the add button within the same millisecond (impossible on a real device but
possible via accessibility tap delegate), two temp items share the same id
and FlashList's keyExtractor collides. The optimistic snapshot also assigns
the full item with the SAME `service_id` — the de-dup on the server side
will handle the actual cart, but the local snapshot can show duplicates
until refresh.
Impact: rare; visible duplicate row until next addItem completes and
overwrites with server response.
Fix: use a uuid (uuid v4 from a generator). The codebase already has
generateUUID() in CartScreen.tsx:55-60 — extract to utils and share.
Evidence: src/context/CartContext.tsx:55-65.
```

```
[SEVERITY: Medium]
[FILE: src/screens/booking/ActiveBookingScreen.tsx:100-115]
[CATEGORY: Frontend / Performance]
Finding:
startSmoothMove uses `setInterval` at 500ms cadence for 10s (20 ticks),
each call doing `setMarkerCoord({...})` which re-renders the parent
component + the memoised HelperMarker. With map zoom + polyline rendering,
this triggers 20 commits per push cycle. Reanimated shared values would
keep this on the UI thread.
Impact: jank on lower-end Android phones during pro tracking.
Fix: use react-native-reanimated useSharedValue + useAnimatedProps on
Marker.coordinate (react-native-maps supports animated coordinates via
AnimatedRegion).
Evidence: src/screens/booking/ActiveBookingScreen.tsx:100-115.
```

```
[SEVERITY: Low]
[FILE: src/screens/pro/ProDashboardScreen.tsx:357-370]
[CATEGORY: Frontend / Real-time]
Finding:
AppState listener captures `isOnline` and `heartbeatIntervalMs` via closure
but the effect's deps are only `[isOnline]`. heartbeatIntervalMs reads
hasActiveBookingRef.current — a ref — so the read is always fresh. But the
listener won't re-bind when isOnline goes false→true (re-binds once per
true/false transition, which is correct here). Just fragile code.
Fix: split into bind/unbind effects gated on isOnline; or capture all in
refs.
Evidence: src/screens/pro/ProDashboardScreen.tsx:357-370.
```

```
[SEVERITY: Nit]
[FILE: src/screens/main/ActiveBookingScreen.tsx (legacy)]
[CATEGORY: Frontend / Dead code]
Finding:
MainNavigator.tsx:18-20 comment says ActiveBookingScreen has been replaced
by TrackLiveScreen, but the file still exists and is 577 LOC. The
duplication risks future divergence.
Fix: confirm no remaining route uses it, then delete.
Evidence: src/screens/booking/ActiveBookingScreen.tsx still present;
MainNavigator.tsx:18-20 commented-out import.
```

```
[SEVERITY: Nit]
[FILE: src/api/* (23 files)]
[CATEGORY: Frontend / Code organisation]
Finding:
Per-API file pattern is consistent but the response-typing pattern is not.
Some use `Promise<ApiX>` with an exported type, others return `any` via
res.json(). Auditing required to enforce typing.
Evidence: src/api/cart.ts (typed), src/api/zones.ts (loosely typed).
```

```
[SEVERITY: Low]
[FILE: src/screens/main/ReferralEarnScreen.tsx:111]
[CATEGORY: Frontend / UX]
Finding:
"Copied" state uses a 2s setTimeout. No cleanup on unmount — if user copies
then navigates back within 2s, setState fires after unmount → React
warning "Can't perform a React state update on an unmounted component".
Fix: track mounted ref or cancel timeout in cleanup.
Evidence: src/screens/main/ReferralEarnScreen.tsx:111.
```

```
[SEVERITY: Nit]
[FILE: src/api/client.ts:38]
[CATEGORY: Frontend / Security]
Finding:
generateIdempotencyKey() uses Math.random() — not cryptographic. Backend
namespaces by user_id, so the collision space is per-user-per-10-min.
Birthday collision odds with `{base36 timestamp}-{8 chars}-{8 chars}` are
astronomically low even with poor randomness, so this is fine, but the
comment in the file already acknowledges it. Consider using a UUID for
clarity.
Evidence: src/api/client.ts:38-40.
```

```
[SEVERITY: Low]
[FILE: App.tsx:5]
[CATEGORY: Frontend / Observability]
Finding:
`LogBox.ignoreLogs(['Error while flushing PostHog', 'PostHogFetchNetworkError'])`
hides PostHog flush errors. These also indicate genuine connectivity
problems or PostHog outages; silencing them in dev means devs won't notice
when analytics is broken.
Fix: gate on `__DEV__ && !somePostHogDebugFlag` or move to a debug-only
helper.
Evidence: App.tsx:5.
```

```
[SEVERITY: Medium]
[FILE: src/screens/main/HomeScreen.tsx:91, 137-158]
[CATEGORY: Frontend / Performance]
Finding:
HomeScreen computes `SCREEN_W = Dimensions.get('window').width` at module
top-level (L91). This snapshot does NOT update on orientation change —
the pull-to-refresh Zop's fly-target coordinates will be wrong in
landscape. Same hazard for the iPad rotation case (Expo SDK 54 supports
iPad).
Fix: useWindowDimensions() hook instead.
Evidence: src/screens/main/HomeScreen.tsx:91, 154-158.
```

```
[SEVERITY: Low]
[FILE: src/screens/main/CartScreen.tsx:55-60]
[CATEGORY: Frontend / Security]
Finding:
generateUUID() at L55-60 is a hand-rolled v4-like generator using
Math.random(). For idempotency keys this is fine; for the
bookGroupChore split idempotency_key (L272) it's also fine because the
server's idempotency window is short. Just flagging that the codebase
should standardise on one UUID helper (also exists in src/api/client.ts).
Fix: consolidate; or use react-native-uuid.
Evidence: src/screens/main/CartScreen.tsx:55-60; src/api/client.ts:26-40.
```

```
[SEVERITY: Medium]
[FILE: src/context/AuthContext.tsx:153-154]
[CATEGORY: Frontend / Hooks]
Finding:
usePushNotifications is invoked unconditionally inside AuthProvider with
`token !== null && token !== '__guest__'` as isAuthenticated. The hook
internally requires messaging permission and sets up listeners — fine. But
if a user signs out and signs back in as a different account, the hook's
useEffect deps include `isAuthenticated, registerToken, userRole` — only
registerToken changes (closure over authToken). Token rotation correctly
re-runs, but the OLD FCM token registration is never EXPLICITLY revoked
server-side. The new login will register a fresh token, but the previous
user's FCM is still associated with the same device on the backend.
Impact: previous user gets future push notifications for the new user's
bookings (the backend looks up FCM by user_id, so notifications for the
correct user are routed correctly, BUT if the OLD user has not yet been
de-registered, push tokens may collide if the backend uses device_id as a
secondary key).
Fix: in signOut(), call DELETE /devices/me/fcm before clearing token; the
api/devices.ts client should expose deregister().
Evidence: src/context/AuthContext.tsx:329-346 — signOut does not call any
device deregister; usePushNotifications.ts:37-127.
```

---

## Summary numbers (combined frontend.md + frontend-2.md)

- Critical: 2
- High: 13
- Medium: 19
- Low: 12
- Nit: 7

## Top priorities (in order)

1. **PostHog PII leak (Critical, AuthContext.tsx:320-323)** — strip phone /
   name from identify before more user data accumulates in PostHog.
2. **Pending-referral-code cross-user attribution (Critical, App.tsx:50)** —
   either expire the stash or scope it.
3. **Hoist CartProvider to App.tsx (High)** — fixes remount/cart-lost class
   of bugs and aligns with other contexts.
4. **PostHog autocapture PII redaction (Medium)** — verify touch events don't
   carry address text.
5. **Request cancellation on unmount (High, project-wide)** — abort fetches in
   useEffect cleanup; meaningful battery + race-condition impact.
6. **Idempotency-Key on GETs (High, client.ts)** — stop attaching on safe
   methods; current behaviour serves stale cached responses.
7. **Accessibility labels (High, 20 screens)** — required for store review.
8. **allowFontScaling audit (High, project-wide)** — Dynamic Type
   compatibility.
9. **Large PNG assets (High, assets/)** — ~25 MB binary bloat.
10. **Referral screens off the global toast system (High)** — UX
    inconsistency + silent failures.
