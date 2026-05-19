# ZopMop Audit — Quick Wins (≤30 minute fixes)

Every item here is mechanical: known file, known edit, no design call required.
Listed top-down by impact-per-minute. Pair with `STORE_READINESS.md` — most
of the store-blocker BLOCKERs land in this file.

---

## Store-blocking — fix first (≤2 hours total)

1. **Strip 3 unused permissions from Android manifest** — 2 min.
   File: `App/zopmop-app/android/app/src/main/AndroidManifest.xml:12,15,16`.
   Delete `<uses-permission>` for `SYSTEM_ALERT_WINDOW`,
   `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`.

2. **Dedupe iOS `Info.plist`** — 3 min.
   File: `App/zopmop-app/ios/zopmopapp/Info.plist`.
   - `UIBackgroundModes` array has `remote-notification` and `fetch` twice each — remove duplicates.
   - `CFBundleURLTypes` has the Google OAuth URL scheme twice — remove the duplicate dict.

3. **Drop the FaceID privacy string** — 1 min.
   File: `App/zopmop-app/ios/zopmopapp/Info.plist:69-70`.
   Remove `NSFaceIDUsageDescription` entirely; app does not use FaceID.

4. **Rewrite the two "Always" location privacy strings** — 3 min.
   File: `App/zopmop-app/ios/zopmopapp/Info.plist:71-74`.
   Replace the templated "Allow $(PRODUCT_NAME) to access your location" with
   either a humane sentence or — preferred — remove both keys (the app only
   uses WhenInUse, which already has a good description).

5. **Bump iOS min OS version** — 1 min.
   File: `App/zopmop-app/ios/zopmopapp/Info.plist:58`.
   Change `LSMinimumSystemVersion` from `12.0` to `15.1` to match Expo SDK 54.

6. **Switch `aps-environment` to production for production EAS profile** — 5 min.
   File: `App/zopmop-app/app.json` `ios.entitlements.aps-environment`.
   Either flip to `"production"` or move to an `app.config.js` branch on
   `process.env.APP_ENV`.

7. **Reconcile Android bundle ID** — 5 min.
   File: `App/zopmop-app/android/app/build.gradle:91-92`.
   Replace `namespace "com.zopmopapp"` and `applicationId "com.zopmopapp"` with
   `com.zopmop.app` everywhere. Match manifest, app.json, AASA, assetlinks.

8. **Privacy + Terms remove "Draft notice" banner** (when legal review lands)
   — 2 min once delivered.
   File: `website/privacy.html` and `website/terms.html`.

---

## Backend — quick safety wins

9. **Cap chat-message length feeding OpenRouter** — 10 min.
   File: `internal/zop/service.go`. Add `if len(msg) > 4000 { return ErrMessageTooLong }`
   before handing to OpenRouter. Same guard belongs at the handler validator.

10. **Sanitize raw `err.Error()` returns in BFF admin handler** — 15 min.
    File: `internal/bff/admin_handler.go`. Replace `fmt.Sprintf("error: %s", err.Error())`
    with a constant message + structured log on the server side.

11. **Add `Idempotency-Key` to CORS allowed headers** — 2 min.
    File: `cmd/api/main.go` (Helmet/CORS config). The header is being sent by
    the mobile client but the preflight rejects it.

12. **Drop the JWT-claim `is_suspended` fallback path** — 10 min.
    File: `middleware/auth.go:139-145` (also duplicated at
    `booking/tracking_ws.go:139` and `location/handler.go:150`). Always go via
    `SuspensionChecker`; if it's nil, fail-closed.

13. **Add `WithLeeway(30 * time.Second)` to JWT parser** — 3 min.
    File: `auth/service.go` or `middleware/jwt.go`. Eliminates clock-skew 401s.

14. **Add an explicit `time.Now().UTC()` floor on every CRON loop start** — 5 min.
    `internal/leave`, `internal/roomies` cron loops. Avoid drift.

15. **Add `Idempotency-Key` to wallet topup + booking cancel + booking accept**
    — 15 min. They run through the existing middleware; just register them.

---

## Mobile / RN — quick safety wins

16. **PostHog identify drop phone + name from $set** — 5 min.
    File: `src/context/AuthContext.tsx:320-323`. Change to
    `posthog.identify(uid)` only. Track phone via hash if you need it later.

17. **Disable PostHog autocapture or add `beforeCapture` redactor** — 10 min.
    File: `src/config/posthog.ts`. `captureTouches: false` OR add a redactor
    that scrubs address-like text from touch events.

18. **Bind referral code AsyncStorage entry to a TTL + clear on logout** — 10 min.
    File: `App.tsx:42-69`. Add a 24 h timestamp + clear on logout to prevent
    cross-user attribution. Better: scope to a session ID.

19. **Move `CartProvider` from `MainNavigator` up to `App.tsx`** — 5 min.
    Avoids remount-on-auth-swap and lost optimistic state.

20. **Remove `Idempotency-Key` from GET requests in api client** — 5 min.
    File: `src/api/client.ts:74`. Add a guard `if (method !== 'GET')`.

21. **Add `accessibilityLabel` to the 8 most-touched controls** — 20 min.
    Cart `+/-` buttons (qty), Pro Accept button on ActiveBooking, Add to Cart,
    Search, Cancel Booking, Confirm Booking, Apply Referral, Submit Address.

22. **Set `allowFontScaling={true}` (or `false` deliberately) globally** — 5 min.
    Define a `<Text>` wrapper component once.

23. **Remove `react-native-svg` raw fallback emojis from ServiceAboutScreen
    and ProOnboardingScreen** — 10 min. Per existing `project_svg_icons_revamp`
    memory; swap to Feather while waiting for the 3D icon set.

24. **Brand: replace "ZOPMOP" all-caps wordmark with "ZopMop" mixed case** —
    5 min across 3 files: `HomeFooter.tsx:171`, `ProfileScreen.tsx:405`,
    `WalletScreen.tsx:269`.

25. **Mascot Lottie: change `resizeMode="cover"` → `"contain"`** — 5 min across
    7 files in `screens/auth/`. Stops cropping/distortion.

---

## Dead code / cleanup

26. **Remove the 6 likely-unused Expo deps after a focused grep** — 15 min:
    `expo-device`, `expo-file-system`, `expo-localization`, `expo-status-bar`,
    `expo-updates`, `expo-dev-client`. **Confirm each via `grep -r '<pkg>'` first.**

27. **Delete the commented-out import at `MainNavigator.tsx:20`** — 1 min.

28. **Remove 4 unused theme color tokens** — 3 min: `primaryLight`, `accentLight`,
    `info`, `infoBg` in `src/theme/colors.ts`.

29. **Drop the 11 stale TODO/FIXME comments** that have no associated issue
    tracker entry — 10 min if you decide to either action or convert each
    to a github issue. List in `findings/dead-code.md`.

---

## Quality of life

30. **Wire `staticcheck` into CI** — 15 min: add to GitHub Action.
31. **Turn on TS `noUnusedLocals` + `noUnusedParameters`** — 20 min including
    deleting the 35 flagged unused entries.
32. **Add `.editorconfig` if not present** to lock LF + UTF-8 + final-newline
    across mobile + backend.
33. **Set `NodeJS engines` field in `App/zopmop-app/package.json`** to pin the
    Node version EAS / local dev should use.

---

Total time budget for ALL quick wins: **~5-6 focused hours**.

If under time pressure, do items 1-8 (store blockers) + items 9-14 (backend
safety) + items 16-20 (mobile safety). That's the highest-leverage 3 hours.
