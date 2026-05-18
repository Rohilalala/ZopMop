# Store Readiness — launch-blocking checklist

Sourced from `audit/findings/store-readiness.md` (Subagent 12).
Cross-reference for finding detail, file:line, evidence.

Counts: BLOCKER 8, HIGH RISK 9, ASO 6, POLICY DEBT 5.

---

## BLOCKER — will cause rejection

- [ ] **#1** Android: remove `SYSTEM_ALERT_WINDOW` from
  `App/zopmop-app/android/app/src/main/AndroidManifest.xml:12`.
  Play permission-policy rejection guaranteed otherwise.
- [ ] **#2** Android: remove `READ_EXTERNAL_STORAGE` +
  `WRITE_EXTERNAL_STORAGE` lines 15-16 of same manifest. No
  in-app use, Play scrutinizes broad-storage declarations.
- [ ] **#3** iOS: populate `NSPrivacyCollectedDataTypes` in
  `App/zopmop-app/ios/zopmopapp/PrivacyInfo.xcprivacy:45`. Currently
  an empty array even though PostHog + Firebase + Cashfree + Maps
  collect substantial data. App Store Connect rejects on upload.
- [ ] **#4** iOS: dedupe `UIBackgroundModes` and `CFBundleURLTypes`
  arrays in `App/zopmop-app/ios/zopmopapp/Info.plist:27-53,79-85`.
  Duplicate Google OAuth URL scheme rejected by static validator.
- [ ] **#5** iOS: replace placeholder usage strings in Info.plist
  lines 69-74. `NSFaceIDUsageDescription` should be removed (no
  Face ID usage), `NSLocationAlways*` strings should be humane or
  removed. Apple 5.1.1 rejection trigger.
- [ ] **#6** Android: release `signingConfig` in
  `App/zopmop-app/android/app/build.gradle:112-117` uses the debug
  keystore. Generate a release keystore (or rely on EAS-managed
  credentials and remove this fallback). Also update
  `website/.well-known/assetlinks.json` SHA-256 to the release-key
  fingerprint before Play submission.
- [ ] **#7** Android: reconcile bundle ID. `build.gradle:91-92`
  uses `com.zopmopapp`, everything else (manifest, app.json,
  assetlinks.json, iOS) uses `com.zopmop.app`. App will either
  crash on launch or break universal links.
- [ ] **#8** Verify Google Maps API key
  `AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0` (Info.plist:5-6,
  app.json:39-41, react-native-maps plugin) is restricted in GCP to
  iOS bundle + Android package + SHA-256, with API + quota caps.

## HIGH RISK — likely rejection or post-launch removal

- [ ] **#9** App Review Notes: explicitly call out Cashfree → real-
  world services per Apple 3.1.5(a) exemption. No code change.
- [ ] **#10** ATT: keep PostHog first-party. App Review Notes
  should state no IDFA / cross-app tracking. Reconsider if you
  ever enable IDFA collection.
- [ ] **#11** UGC: add report/block on every chat message
  (`src/screens/main/ChatScreen.tsx`). Apple 1.2 + Play UGC.
- [ ] **#12** UGC: add report-review affordance for pros viewing a
  customer's review (BookingRateScreen → pro side).
- [ ] **#13** Replace `website/privacy.html` + `website/terms.html`
  with legally-reviewed final versions. Both currently carry a
  "Draft notice" banner.
- [ ] **#14** iOS: bump `LSMinimumSystemVersion` from `12.0` to
  `15.1` (Info.plist:58). Expo SDK 54 requires it; current value
  will fail validation or crash on iOS 12-14.
- [ ] **#15** iOS: switch `aps-environment` entitlement from
  `development` to `production` for production EAS profile.
- [ ] **#16** Account-deletion 409 UNPAID_BOOKINGS path: either
  allow deletion regardless (collect debt out-of-band) or document
  the contractual retention in privacy policy + delete-account
  prompt. Apple 5.1.1(v).
- [ ] **#17** Android 12+ splash: verify `expo-splash-screen` is
  fully configured per Expo SDK 54 docs for the SplashScreen API.

## ASO — affects discoverability/conversion

- [ ] **#18** Establish `App/zopmop-app/store/{appstore,playstore}/`
  metadata directories tracked in repo. Include screenshots for
  iPhone 6.7/6.5/5.5, iPad 13", Android phone, 7", 10" tablet, and
  Play feature graphic 1024x500.
- [ ] **#20** Author iOS subtitle (30 char) + Play short
  description (80 char) before submission.
- [ ] **#21** iOS keyword field strategy — avoid competitor names.
- [ ] **#22** Hindi (hi-IN) store-listing localization at minimum;
  in-app i18n phase 2.
- [ ] **#23** Add `expo-store-review` and trigger post-positive
  events to drive review velocity.
- [ ] **#19** Confirm store-listing title and display name at
  submission (no code change needed).

## POLICY DEBT — fix before scale

- [ ] **#24** DPDP compliance: notice + consent on OTP screen,
  grievance officer in privacy policy, cross-border transfer
  disclosure (Firebase US, PostHog).
- [ ] **#25** Pricing transparency: verify cart shows final cost
  before booking confirm (no post-confirm surge).
- [ ] **#26** Refund / cancellation policy reachable from in-app
  Profile screen.
- [ ] **#27** Add in-app analytics opt-out toggle that calls
  `posthog.optOut()`. Apple 5.1.2 + DPDP.
- [ ] **#28** Trademark "ZopMop" — verify Indian TM registry +
  USPTO before launch.

---

Already good — do not rework:

- Account-deletion end-to-end (UI → API → backend purge).
- AASA + assetlinks served from zopmop.com, content-type fixed.
- Booking dispute flow (`ReportIssueScreen` → POST /disputes).
- iOS icon has no alpha; adaptive icon configured for Android.
- Cashfree → physical services (no IAP violation).
- Firebase phone OTP sole auth (no Sign-in-with-Apple required).
- `ITSAppUsesNonExemptEncryption = false`.
- Expo SDK 54 default targetSdk = 35 (meets Play 2026 floor).
- `expo-updates` wired for hot-fixes.
