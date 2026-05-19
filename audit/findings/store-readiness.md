# Subagent 12 — App Store & Play Store Readiness

Scope: `App/zopmop-app/` mobile binary + store metadata + privacy/legal
surface. Goal: enumerate everything that will trigger an iOS / Play
rejection, plus the ASO + policy-debt items.

Reviewer: Subagent 12. Date: 2026-05-15. Cross-references prior
findings in `REPO_MAP.md` and `AUDIT_2025_2026-05-03.md`.

---

## SUMMARY

- BLOCKER findings: 8
- HIGH RISK findings: 9
- ASO findings: 6
- POLICY DEBT findings: 5

The single most damaging cluster is **privacy / data-safety**: the
`PrivacyInfo.xcprivacy` declares no collected data types and tracking
= false, even though PostHog, Firebase Auth, FCM, Cashfree, and Google
Maps are all integrated. That mismatch causes Apple binary-rejections
and Play Data-safety form violations. Second-worst cluster is
**Android permissions** — three permissions in the manifest (notably
`SYSTEM_ALERT_WINDOW`) that are unjustified and Play-policy-rejected
on submission. Account deletion, dispute flow, and AASA/assetlinks
are in good shape.

---

## BLOCKERS — will cause submission rejection

### 1. Android — unjustified SYSTEM_ALERT_WINDOW (Play policy rejection)

```
[SEVERITY: Critical]
[FILE: App/zopmop-app/android/app/src/main/AndroidManifest.xml:12]
[CATEGORY: Store / Android permissions]
[BLOCKER STATUS: BLOCKER]
```

Finding: `android.permission.SYSTEM_ALERT_WINDOW` is declared with no
justification, no entry in `app.json` `android.permissions`, and no
code that uses overlay UI. Comment block above it literally reads
"OPTIONAL PERMISSIONS, REMOVE WHATEVER YOU DO NOT NEED".

Impact: Google Play Permissions policy requires a SYSTEM_ALERT_WINDOW
declaration form and live-overlay justification. Apps that request it
without use-case approval are removed at review. SYSTEM_ALERT_WINDOW
is also auto-revoked on Android 11+ unless the app is granted special
access. Submission will be rejected.

Fix: Delete the `<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW"/>`
line. Re-run `expo prebuild --clean` after changing `app.json` so this
doesn't get reintroduced on next prebuild.

Evidence: `App/zopmop-app/android/app/src/main/AndroidManifest.xml:12`.
`app.json` only declares `ACCESS_COARSE_LOCATION`,
`ACCESS_FINE_LOCATION`, `POST_NOTIFICATIONS` under
`android.permissions`, so the manifest line is leftover boilerplate
not regenerated from config.

---

### 2. Android — unjustified READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE

```
[SEVERITY: Critical]
[FILE: App/zopmop-app/android/app/src/main/AndroidManifest.xml:15-16]
[CATEGORY: Store / Android permissions]
[BLOCKER STATUS: BLOCKER]
```

Finding: Legacy storage permissions still in the manifest. The app
does not read or write external files (no image picker, no document
download). On Android 13+ these are no-ops and on Play they are
heavily scrutinized; Play console will surface the broad-storage
declaration prompt and a manual review may reject.

Impact: Slows review, may trigger a removal demand for unjustified
broad-storage access. Combined with `SYSTEM_ALERT_WINDOW` above this
is the most common Play rejection trigger.

Fix: Delete both lines from `AndroidManifest.xml`. The Expo prebuild
output should be regenerated from `app.json`, which omits these.

Evidence: same file, lines 15 and 16.

---

### 3. iOS — PrivacyInfo.xcprivacy claims no data collection and no tracking

```
[SEVERITY: Critical]
[FILE: App/zopmop-app/ios/zopmopapp/PrivacyInfo.xcprivacy:45-48]
[CATEGORY: Store / Apple privacy manifest]
[BLOCKER STATUS: BLOCKER]
```

Finding: `NSPrivacyCollectedDataTypes` is `<array/>` (empty),
`NSPrivacyTracking` is `<false/>`. The app integrates:

- `@react-native-firebase/auth` — collects phone number, device ID
- `@react-native-firebase/messaging` — collects device token,
  product interaction
- `posthog-react-native` — collects user ID, screen views, events,
  device identifiers; PostHog `captureAppLifecycleEvents: true` and
  `posthog.identify(authUser.id, …)` is wired in
  `src/context/AuthContext.tsx:320`
- `react-native-cashfree-pg-sdk` — processes payments (purchase
  history, partial PAN handling per Cashfree)
- `react-native-maps` (Google) — coarse + precise location, identifiers

Required collected-data-type entries (minimum):
- Email Address (if collected — verify; currently only phone)
- Phone Number — `NSPrivacyCollectedDataTypeLinkedToUser: true`,
  purpose `AppFunctionality`
- Name — purpose `AppFunctionality`
- Physical Address — `AppFunctionality`
- Precise Location — `AppFunctionality`, `NSPrivacyCollectedDataTypeTracking: false`
- Coarse Location — `AppFunctionality`
- User ID — `AppFunctionality`, `Analytics`
- Device ID — `Analytics`, `AppFunctionality`
- Purchase History — `AppFunctionality`
- Product Interaction — `Analytics`
- Other Usage Data — `Analytics`
- Crash Data — `AppFunctionality`
- Performance Data — `AppFunctionality`
- Diagnostic Data — `AppFunctionality`

Impact: Apple now rejects binaries whose declared data types do not
match the SDK surface they detect via static analysis on App Store
Connect upload. This is the single highest-probability Apple
rejection vector for this binary.

Fix: Replace the empty `NSPrivacyCollectedDataTypes` array with the
list above. Keep `NSPrivacyTracking: false` only if the app does not
do cross-app tracking (current PostHog config does not look like ATT
tracking, so false is defensible). Match the matrix with the App
Privacy questionnaire in App Store Connect.

Evidence: file 1-50; package.json dependencies; AuthContext.tsx:11,320,325.

---

### 4. iOS — duplicate UIBackgroundModes and CFBundleURLTypes entries

```
[SEVERITY: High]
[FILE: App/zopmop-app/ios/zopmopapp/Info.plist:27-53, 79-85]
[CATEGORY: Store / iOS Info.plist hygiene]
[BLOCKER STATUS: BLOCKER]
```

Finding: `UIBackgroundModes` array contains `remote-notification` and
`fetch` twice each (lines 81-84). `CFBundleURLTypes` lists the same
Google OAuth URL scheme `com.googleusercontent.apps.506963622768-…`
twice (lines 28-34 and 35-40).

Impact: Apple's static validator will flag the duplicate URL scheme
as "an app may not have multiple entries with the same URL scheme"
and reject the binary. Duplicate `UIBackgroundModes` will cause
build-time warnings and may trigger ITMS-90000-class errors on App
Store Connect upload depending on validator version.

Fix: Remove duplicates from both arrays. Single Google OAuth scheme.
Single `remote-notification` and single `fetch`. Also reconcile
`app.json` `ios.infoPlist.UIBackgroundModes` with the prebuild output
so it does not regenerate duplicates on next `expo prebuild`.

Evidence: `App/zopmop-app/ios/zopmopapp/Info.plist:27-53,79-85`.

---

### 5. iOS — placeholder usage descriptions ("Allow $(PRODUCT_NAME) to access your X")

```
[SEVERITY: Critical]
[FILE: App/zopmop-app/ios/zopmopapp/Info.plist:69-74]
[CATEGORY: Store / iOS privacy strings]
[BLOCKER STATUS: BLOCKER]
```

Finding: Three privacy strings still contain Apple's templated
boilerplate, which is a documented Apple rejection trigger:

- `NSFaceIDUsageDescription` = "Allow $(PRODUCT_NAME) to access your
  Face ID biometric data." — but the app does not use FaceID for any
  feature (only Firebase phone OTP). This string should not be
  present at all unless Face ID is actually used.
- `NSLocationAlwaysAndWhenInUseUsageDescription` = "Allow
  $(PRODUCT_NAME) to access your location" — generic placeholder.
- `NSLocationAlwaysUsageDescription` = same generic string.

(`NSLocationWhenInUseUsageDescription` is correctly customised.)

Impact: Apple Guideline 5.1.1 / Information Property List Key
documentation explicitly rejects generic privacy strings. FaceID
declaration without FaceID usage is a 5.1.1 binary rejection. App
will be rejected on first review.

Fix:
- Remove `NSFaceIDUsageDescription` entirely (the app does not call
  any biometric API in `src/`).
- The app uses only foreground location; remove
  `NSLocationAlwaysUsageDescription` and
  `NSLocationAlwaysAndWhenInUseUsageDescription` unless background
  location is actually wired. If neither — only
  `NSLocationWhenInUseUsageDescription` should be present.
- If "always" location is genuinely needed for the pro side, supply
  a human string: e.g. "ZopMop pros share live location with their
  customer during an active job so the customer can see ETA. Used
  only when a job is in progress."

Also align with `app.json` `expo-location` plugin (line ~76 in
app.json) which already provides a humane in-use string — drop the
"always" variants until background tracking is built.

Evidence: Info.plist:69-74; app.json plugin block for expo-location.

---

### 6. Android — debug keystore signing in release builds

```
[SEVERITY: Critical]
[FILE: App/zopmop-app/android/app/build.gradle:112-117]
[CATEGORY: Store / Android signing]
[BLOCKER STATUS: BLOCKER]
```

Finding: The release `buildType` is configured with
`signingConfig signingConfigs.debug` — the debug keystore. The
comment immediately above warns "Caution! In production, you need to
generate your own keystore file."

Impact: Two failure modes. (a) If a release AAB is built locally with
the bundled debug.keystore and uploaded to Play, the upload is
rejected because the debug certificate is not the Play app-signing
certificate AND because the cert has a CN of "Android Debug" which
Play console rejects for new uploads. (b) Even if uploaded, the
SHA-256 in `website/.well-known/assetlinks.json` is the debug
fingerprint, so universal links would break the moment a real release
key is used — locking you into the debug cert forever or breaking
deep links.

Note: EAS builds bypass this signingConfig and use the EAS-managed
keystore, so production EAS pipelines may work. But the gradle config
itself is wrong and any local `./gradlew :app:bundleRelease` will
produce a debug-signed AAB. Belt-and-suspenders: also fix here.

Fix: Generate a release keystore (or rely fully on EAS-managed
credentials). Replace the release `signingConfig` block. Update
`assetlinks.json` SHA-256 to the release-key fingerprint (already
flagged in user memory as a known release pre-req).

Evidence: build.gradle:112-117; user memory note re: debug SHA-256
in `assetlinks.json`.

---

### 7. Android — bare-name Application ID mismatch with declared package

```
[SEVERITY: Critical]
[FILE: App/zopmop-app/android/app/build.gradle:91-92]
[CATEGORY: Store / Android packaging]
[BLOCKER STATUS: BLOCKER]
```

Finding: `namespace "com.zopmopapp"` and
`applicationId "com.zopmopapp"` on lines 91 and 92, but `app.json`
declares Android `package: "com.zopmop.app"` and the
`AndroidManifest.xml` uses `com.zopmop.app.MainApplication` and
`com.zopmop.app.MainActivity` (line 28-29). The `assetlinks.json`
also targets `com.zopmop.app`.

Impact: Either (a) the manifest activity class won't resolve at
runtime — app crashes on launch on real device, or (b) the app
deploys under bundle ID `com.zopmopapp` rather than `com.zopmop.app`
— breaking universal links (AASA appID `2P38R9F468.com.zopmop.app`)
and locking the Play listing to a different package than the iOS
companion. Either is a launch-blocking discrepancy that needs to be
reconciled before submission.

Fix: Decide on a canonical bundle ID (`com.zopmop.app` per the AASA,
assetlinks, iOS, and app.json). Update build.gradle namespace +
applicationId to match, and re-run prebuild.

Evidence: build.gradle:91-92; AndroidManifest.xml:28-29; app.json
android.package; website/.well-known/assetlinks.json package_name.

---

### 8. iOS — Google Maps API key embedded in plist + app.json

```
[SEVERITY: Critical]
[FILE: App/zopmop-app/ios/zopmopapp/Info.plist:5-6 and App/zopmop-app/app.json:39-41]
[CATEGORY: Store / Secrets-in-source]
[BLOCKER STATUS: BLOCKER]
```

Finding: The Google Maps API key
`AIzaSyCYCxpNia7E01jVn9AnHUgyPgUC4-HYYQ0` is embedded in plain text
in two source-controlled files. This is the post-rotation key per
user memory, but it must be (a) restricted in Google Cloud Console
to the iOS bundle ID `com.zopmop.app` (iOS apps) and Android
package + SHA-256 (Android apps), and (b) not exposed in any web
referrer or "no restriction" mode.

Impact: Without restriction, the key can be extracted from the
shipping IPA/AAB and used by anyone, racking up billing. With
restriction in place, the embedding is acceptable (it's how
react-native-maps expects to receive it). Without verification this
is launch-blocking from a financial-risk and policy-debt angle.

Fix: Verify in Google Cloud Console that the key is restricted to
iOS bundle `com.zopmop.app` AND Android package `com.zopmop.app`
with the release SHA-256. Add API restrictions to "Maps SDK for
iOS" + "Maps SDK for Android" + "Places API" + whatever else is
actually called. Set quota caps. Treat as out-of-scope for code edit
but in-scope to confirm before submission.

Evidence: Info.plist:5-6; app.json:39-41 and the react-native-maps
plugin block.

---

## HIGH RISK — likely rejection or removal post-launch

### 9. Cashfree integration without explicit IAP-exempt disclosure

```
[SEVERITY: High]
[FILE: n/a — store listing]
[CATEGORY: Store / Apple payments policy]
[BLOCKER STATUS: HIGH RISK]
```

Finding: The app processes payments via Cashfree, which is correct
under Apple Guideline 3.1.5(a) since the transactions are for
real-world services (cleaning, dishwashing — physical services
delivered offline by a pro). No code path in `src/` sells digital
goods or subscriptions via Cashfree.

Impact: Apple frequently flags Indian apps with Razorpay/Cashfree
asking for IAP. Provide a clear note in the App Review Notes field
on App Store Connect: "All payments are for real-world household
services delivered offline by independent professionals. No digital
content, subscriptions, or unlockables are sold. Per Guideline
3.1.5(a) physical services are exempt from IAP."

Fix: Add the above note to the App Review Notes field at submission
time. Action by submitter; no code change.

Evidence: package.json deps include `react-native-cashfree-pg-sdk`;
no subscription or digital-good string found in `src/`.

---

### 10. PostHog tracking — ATT consideration

```
[SEVERITY: High]
[FILE: App/zopmop-app/src/config/posthog.ts; App/zopmop-app/ios/zopmopapp/Info.plist]
[CATEGORY: Store / iOS ATT]
[BLOCKER STATUS: HIGH RISK]
```

Finding: PostHog is configured (`captureAppLifecycleEvents: true`)
and identifies users by ID (`posthog.identify` in AuthContext.tsx).
This is **first-party analytics**, not cross-app tracking, so ATT is
NOT required — but Apple reviewers sometimes flag any analytics SDK
and ask. There is no
`NSUserTrackingUsageDescription` in Info.plist, and no call to
`requestTrackingPermissionsAsync` in `src/`.

Impact: If PostHog ever enables `idfa` collection, session-replay
cross-app linking, or session merge across other PostHog projects,
the app would need ATT. As shipped today it's borderline acceptable
but a reviewer challenge is possible.

Fix: Stay first-party. In `App Review Notes`, write: "Analytics
(PostHog) is configured first-party with no IDFA/SKAdNetwork or
cross-app tracking. NSUserTrackingUsageDescription intentionally
omitted." If the team enables IDFA later, add NSUserTracking…
string AND a non-blocking modal that calls
`requestTrackingPermissionsAsync` post-onboarding.

Evidence: src/config/posthog.ts:25-39; src/context/AuthContext.tsx:320.

---

### 11. UGC moderation — chat has no report/block/mute

```
[SEVERITY: High]
[FILE: App/zopmop-app/src/screens/main/ChatScreen.tsx]
[CATEGORY: Store / UGC moderation]
[BLOCKER STATUS: HIGH RISK]
```

Finding: `src/screens/main/ChatScreen.tsx` (356 lines) is the
customer-pro chat surface. Grep for `report|block|mute|abuse` in
that file returns zero matches. Same on the pro-side variants.
Apple Guideline 1.2 (and Play UGC policy) requires apps with
user-to-user messaging to provide (a) a way to report objectionable
content, (b) a way to block abusive users, and (c) a published
moderation SLA (24 h commonly cited).

Impact: This is one of the top three Apple rejection clusters for
service-marketplace apps in India. Without report/block in chat the
app fails 1.2 on first review.

Fix: Add a long-press / overflow menu on each message with "Report
message" and "Block user". Wire to a new `POST /messages/:id/report`
endpoint with reason categories (spam, harassment, inappropriate,
threat, other). Mark the customer-pro pairing as blocked so future
matching skips it. Document the moderation SLA in `privacy.html`
and the App Store description.

The existing `ReportIssueScreen.tsx` (dispute flow) is booking-level,
not message-level. That covers booking disputes but doesn't satisfy
the per-message moderation requirement.

Evidence: ChatScreen.tsx (no report/block); ReportIssueScreen.tsx:22
(uses fileDispute, booking-level).

---

### 12. UGC moderation — review/rating system has no report on abusive reviews

```
[SEVERITY: High]
[FILE: App/zopmop-app/src/screens/main/BookingRateScreen.tsx]
[CATEGORY: Store / UGC moderation]
[BLOCKER STATUS: HIGH RISK]
```

Finding: Customers submit free-text reviews of pros via
`BookingRateScreen.tsx`. Pros likely cannot report a customer's
malicious review. The Pro app does not appear to surface incoming
reviews either, let alone a "Report this review" button.

Impact: Same Guideline 1.2 cluster. Apple flagged this in several
recent India-marketplace review cycles.

Fix: Add a "Report review" affordance on the pro's profile (visible
to the pro who received it). Hide reviews containing profanity via
server-side filter on `POST /bookings/:id/rate`. Surface the report
UI on `ProDashboardScreen` or wherever reviews are displayed to the
pro.

Evidence: BookingRateScreen.tsx; no `reportReview` or similar in
`src/api/`.

---

### 13. Privacy + Terms pages are draft / placeholder

```
[SEVERITY: High]
[FILE: website/privacy.html; website/terms.html]
[CATEGORY: Store / Legal]
[BLOCKER STATUS: HIGH RISK]
```

Finding: Both `privacy.html` and `terms.html` carry an explicit
`<div class="draft-banner">` reading "Draft notice. This is a
placeholder privacy policy published while ZopMop is in pre-launch.
The final, legally-reviewed policy will replace this page before
public launch." The privacy URL is linked from the app at
`OTPVerificationScreen.tsx:35` and `ProfileScreen.tsx:45`. It is
also the URL submitted to App Store Connect and Play Console.

Impact: Apple and Play both require a functional, accurate,
publicly-accessible privacy policy. A page that openly admits it is
a placeholder will be flagged in Apple metadata review and may be
rejected during the Play Data-safety review (since the form is
required to reconcile with the policy).

Fix: Have legal counsel finalize the policy and terms before
submission. Remove the draft-banner div. Ensure the policy lists:
data types collected, third-party SDKs (PostHog, Firebase, Cashfree,
Google Maps), retention period, user rights (DPDP — access,
correction, erasure, grievance), data-fiduciary contact, and the
account-deletion route (currently only in-app).

Evidence: website/privacy.html draft-banner; same in terms.html;
OTPVerificationScreen.tsx:35; ProfileScreen.tsx:45.

---

### 14. iOS minimum deployment target = 12.0

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/ios/zopmopapp/Info.plist:58-59]
[CATEGORY: Store / iOS deployment target]
[BLOCKER STATUS: HIGH RISK]
```

Finding: `LSMinimumSystemVersion = 12.0`. Apple's recommended floor
for new apps in 2026 is iOS 15+. RN 0.81 + Expo SDK 54 require iOS
15.1 minimum per Expo docs.

Impact: Likely build will fail on archive or be rejected by App
Store Connect with ITMS-90683-class warnings. Even if accepted, you
ship a binary that can't actually launch on iOS 12-14 devices —
crashes on first run because Expo SDK 54 native modules require
iOS 15.1.

Fix: Set `LSMinimumSystemVersion` to `15.1` (or higher, matching
Xcode `IPHONEOS_DEPLOYMENT_TARGET`). Verify Podfile
`platform :ios, '15.1'`. Re-run `expo prebuild`.

Evidence: Info.plist:58-59; Expo SDK 54 requirements.

---

### 15. iOS — APS environment = development on entitlements (TestFlight only)

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/app.json (ios.entitlements.aps-environment)]
[CATEGORY: Store / iOS entitlements]
[BLOCKER STATUS: HIGH RISK]
```

Finding: `app.json` declares `ios.entitlements.aps-environment` =
`"development"`. Required value for App Store submission is
`production`.

Impact: TestFlight will work with `development`, but a
production App Store build with `development` APNs entitlement will
either fail to deliver push notifications post-install or fail
App Store Connect validation. Apple sometimes silently downgrades to
production at archive time, but explicit is safer.

Fix: Set `aps-environment` to `production` for the production build
profile (EAS profile-specific or via `app.config.js`). Verify APNs
key in Firebase console is the production key.

Evidence: app.json `ios.entitlements`.

---

### 16. Account-deletion grace period — spec mismatch with App Store guideline

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/screens/main/ProfileScreen.tsx:163-202; App/zopmop-app/src/api/users.ts:62-83]
[CATEGORY: Store / Apple 5.1.1(v)]
[BLOCKER STATUS: HIGH RISK]
```

Finding: In-app account deletion exists. `ProfileScreen.handleDelete`
calls `deleteMe(token)` which hits `DELETE /me` (backend
`internal/compliance` has the soft-delete flow per
`compliance/service.go:27`). Good. But:

- The 409 UNPAID_BOOKINGS escape hatch may be interpreted by an
  Apple reviewer as "the app blocks account deletion behind
  conditions other than legal/tax retention," which Apple 5.1.1(v)
  explicitly disallows. The guideline says deletion must not be
  conditional on resolving disputes unless legally required.
- There is no in-app or in-policy description of what data is
  retained vs purged.

Impact: Possible reviewer challenge. Worst case: a 5.1.1(v)
rejection asking you to allow deletion regardless of unpaid amount
and continue collection out of band.

Fix: Either (a) allow deletion regardless of unpaid balance and
treat the receivable as a normal debt collection process (legal +
finance call), or (b) document the retention reason precisely in the
privacy policy AND show it on the delete-account prompt: "Outstanding
payments must be settled before account deletion under our terms.
This is a contractual obligation; account deletion remains available
once cleared." Also surface "What data we retain after deletion" on
the privacy policy (typically: financial records 7y, tax records as
required).

Evidence: ProfileScreen.tsx:163-202; api/users.ts:62-83;
compliance/service.go:27 et al.

---

### 17. Splash screen API on Android 12+

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/android/app/src/main/AndroidManifest.xml:29]
[CATEGORY: Store / Android visual polish]
[BLOCKER STATUS: HIGH RISK]
```

Finding: MainActivity uses `android:theme="@style/Theme.App.SplashScreen"`.
On Android 12+ the system splash screen API is mandatory; the legacy
splash via theme works but is visibly inferior. Expo's
`expo-splash-screen` provides the correct splash but it isn't fully
configured for the SplashScreen API in `app.json`.

Impact: Visual quality / store-listing screenshots may be downgraded.
Not a hard reject but a Play "App excellence" check.

Fix: Confirm `expo-splash-screen` is configured per Expo SDK 54
docs for Android 12 splash API (foreground image, icon background
color). Verify visually on an Android 13+ device.

Evidence: AndroidManifest.xml:29; app.json `splash` block.

---

## ASO — discoverability & conversion (non-rejection)

### 18. Missing store-listing metadata in repo

```
[SEVERITY: Medium]
[FILE: n/a — store listing]
[CATEGORY: Store / ASO]
[BLOCKER STATUS: ASO]
```

Finding: No `App/zopmop-app/store/`, `fastlane/`, or
`assets/store/` directory. No metadata.json, no screenshots, no
description files in repo. The only artifact is
`App/zopmop-app/dist/metadata.json` (Expo build output, not store
metadata).

Impact: Store listings can't be reviewed via PR. Iteration on copy
requires logging into App Store Connect / Play Console.

Fix: Establish `App/zopmop-app/store/` directory with subfolders:
- `appstore/en-IN/` — name, subtitle, keywords, description,
  promotional_text, support_url, marketing_url.
- `playstore/en-IN/` — title, short_description, full_description,
  promo_text.
- `playstore/hi-IN/` — Hindi localized strings.
- Screenshots subfolders by device size (iPhone 6.7, 6.5, 5.5,
  iPad 13", Android phone, 7", 10" tablet).
- Feature graphic 1024x500 PNG for Play.

This is launch-week scope, not blocker, but should be set up before
spec'ing the launch.

Evidence: directory listing.

---

### 19. App display name "ZopMop" — good; Play title ≤30 chars OK

```
[SEVERITY: Nit]
[FILE: App/zopmop-app/app.json; App/zopmop-app/ios/zopmopapp/Info.plist:11-12]
[CATEGORY: Store / ASO]
[BLOCKER STATUS: ASO]
```

Finding: `CFBundleDisplayName = "ZopMop"`. Six characters, well
under iOS 30. Slug in app.json is `zopmop-app` (used only for EAS,
not user-facing). Recommend store-listing title:
"ZopMop: Home services" (24 chars iOS, 22 chars Play) for
keyword-rich indexing.

Fix: Confirm at submission. No code change.

Evidence: app.json; Info.plist.

---

### 20. No iOS subtitle / Play short description set in repo

```
[SEVERITY: Medium]
[FILE: n/a — store listing]
[CATEGORY: Store / ASO]
[BLOCKER STATUS: ASO]
```

Finding: Subtitle / short_description are the highest-leverage ASO
field on each store. Not tracked in repo. Recommend:
- iOS subtitle (30): "Cleaning, cooking & care."
- Play short description (80): "Book trusted home help —
  cleaning, cooking, dishwashing, eldercare and more, on demand."

Fix: Author at submission time.

Evidence: n/a.

---

### 21. iOS keyword field strategy (100 chars, no spaces)

```
[SEVERITY: Medium]
[FILE: n/a — store listing]
[CATEGORY: Store / ASO]
[BLOCKER STATUS: ASO]
```

Finding: No keyword strategy on file. Recommend (comma-separated,
no spaces, no plurals, no brand-name competitors):
`cleaning,maid,help,housekeeping,domestic,cook,nanny,eldercare,babysitter,dishwashing,deepclean,sweep,mop,delhi,gurgaon`
(95 chars).

Avoid: "UrbanCompany", "Bookmybai", "Helpr" — Apple rejects
competitor names in keywords.

Fix: Use at submission time.

Evidence: n/a.

---

### 22. Hindi localization (hi-IN) missing

```
[SEVERITY: Medium]
[FILE: n/a — store listing & app strings]
[CATEGORY: Store / ASO]
[BLOCKER STATUS: ASO]
```

Finding: `expo-localization` is in deps but no `hi-IN` translations
in `src/`. Store listing has no Hindi locale. India primary market —
this hurts discovery and conversion meaningfully.

Impact: ~30% lower install conversion in Tier 2/3 cities.

Fix: At minimum add hi-IN store listing (title, short description,
description, screenshots with Hindi captions). In-app localization
phase 2.

Evidence: package.json `expo-localization`; src/ scan returns no
i18n directory.

---

### 23. Ratings prompt timing not visible in code

```
[SEVERITY: Low]
[FILE: App/zopmop-app/src/]
[CATEGORY: Store / ASO]
[BLOCKER STATUS: ASO]
```

Finding: No `expo-store-review` or `react-native-store-review`
import found. App never asks for store rating, which suppresses
review velocity.

Fix: Add `expo-store-review`; trigger on a successful 5-star
in-app review submission (post-positive event). Cap to once per
365 days per OS guidance.

Evidence: package.json grep returns no store-review SDK.

---

## POLICY DEBT — fix before scale

### 24. India DPDP — consent capture and grievance officer

```
[SEVERITY: High]
[FILE: website/privacy.html; in-app onboarding]
[CATEGORY: Store / DPDP compliance]
[BLOCKER STATUS: POLICY DEBT]
```

Finding: DPDP Act 2023 (effective 2026) requires:
- Notice + consent at point of collection (not just buried policy).
- Right-of-access, correction, erasure, grievance routes documented.
- Data Protection Officer / grievance officer contact.
- Cross-border transfer disclosure (Firebase + PostHog are in EU/US).

The placeholder privacy page omits all of the above. App's
`OTPVerificationScreen` shows links to privacy/terms but does not
capture explicit checkbox consent.

Impact: DPDP enforcement penalties up to ₹250 cr. Also Play Data-
safety form needs to be answered consistent with DPDP.

Fix: (a) final privacy policy with DPDP sections; (b) explicit
"By tapping Continue you agree to the Privacy Policy and Terms" on
OTP screen (current language likely satisfies implied consent but
verify); (c) name a grievance officer in policy.

Evidence: privacy.html placeholder; OTPVerificationScreen.tsx.

---

### 25. Pricing transparency / surge disclosure

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/screens/main/CartScreen.tsx]
[CATEGORY: Store / pricing]
[BLOCKER STATUS: POLICY DEBT]
```

Finding: Confirm dynamic / surge pricing is disclosed pre-booking
in CartScreen and ServiceAboutScreen. Apple Guideline 3.1.1
requires the user to see total cost before confirm.

Impact: Reviewer challenge possible if surge appears after confirm.

Fix: Make sure the cart page shows a final-cost line (no
"plus convenience fee finalised on confirm" style). Not verified
in this audit pass — flagged as POLICY DEBT for the cart/booking
subagent.

Evidence: CartScreen.tsx in modified files list (not read in this
pass).

---

### 26. Refund / cancellation policy in-app

```
[SEVERITY: Medium]
[FILE: n/a — store listing + in-app]
[CATEGORY: Store / payments policy]
[BLOCKER STATUS: POLICY DEBT]
```

Finding: Apple wants a refund + cancellation policy reachable from
the app, not buried in terms. Search for "refund" in `src/` not
performed in detail — recommend a dedicated `RefundsScreen` or a
section in `terms.html` with anchor link, and a link from
ProfileScreen.

Fix: Audit pass on the booking-cancellation flow with the bookings
subagent.

Evidence: n/a.

---

### 27. App tracking & analytics — minimum data collection

```
[SEVERITY: Medium]
[FILE: App/zopmop-app/src/config/posthog.ts:25-39]
[CATEGORY: Store / Apple 5.1.2]
[BLOCKER STATUS: POLICY DEBT]
```

Finding: PostHog config is broad — `captureAppLifecycleEvents:
true`, `preloadFeatureFlags: true`, `sendFeatureFlagEvent: true`.
No `disableSessionReplay`, no IP-redaction, no GDPR/DPDP opt-out
flag. Apple 5.1.2 expects minimum data collection.

Fix: Add an in-app analytics opt-out toggle in Profile → Privacy.
On opt-out, call `posthog.optOut()`. Document in privacy policy.

Evidence: src/config/posthog.ts.

---

### 28. Trademark "ZopMop"

```
[SEVERITY: Low]
[FILE: n/a]
[CATEGORY: Store / metadata]
[BLOCKER STATUS: POLICY DEBT]
```

Finding: Open question — has "ZopMop" been TM-cleared in India
(class 35 / 39 / 45)? If a prior registrant exists, Play / Apple
may reject the listing on TM dispute.

Fix: Verify via Indian TM registry (ipindia.gov.in) and US TM
registry (uspto.gov) before launch. Out of scope for this audit
but flagged for legal counsel.

Evidence: n/a.

---

## GOOD — already in place

- Account deletion flow exists end-to-end (UI →
  `deleteMe` → backend `compliance` service). Apple 5.1.1(v)
  satisfied modulo finding #16.
- AASA + assetlinks served from zopmop.com with correct
  `.htaccess` `Content-Type: application/json`. Universal-link
  domain verified.
- Booking dispute flow exists (`ReportIssueScreen` →
  `POST /disputes`) — useful for App Review Notes evidence.
- Adaptive icon configured for Android.
- iOS icon (icon.png) does not contain alpha — Apple-compliant.
- Cashfree integration is for real-world services (no IAP
  exemption violation).
- Firebase phone OTP is sole auth provider — no third-party social
  sign-in, so Sign in with Apple is NOT required (Apple 4.8 not
  triggered).
- `ITSAppUsesNonExemptEncryption = false` set correctly.
- `expo-updates` is wired so post-launch hot-fixes are possible.
- Expo SDK 54 default targetSdk = 35 / compileSdk = 35 — meets
  Play's API 35 requirement for new apps in 2025-2026.

---

## QUESTIONS FOR ADITYA

1. Is the Google Maps API key actually restricted in GCP to
   bundle/package + SHA-256? (Memory says rotated, doesn't confirm
   restrictions.)
2. Is the production EAS build using a managed keystore, or a
   manually-supplied one? If managed, fingerprint must be pulled
   from EAS and used to update `assetlinks.json`.
3. What's the canonical bundle ID — `com.zopmop.app` (everywhere
   else) or `com.zopmopapp` (build.gradle)? Need to fix one of
   them before next release build.
4. Is the privacy/terms legal-review on a timeline that fits
   submission? If not, the draft banner alone is a near-certain
   reject.
5. Is the team OK with the analytics-opt-out feature being
   deferred to post-launch? DPDP enforcement starts to bite in
   2026.
6. Is in-app FaceID actually used anywhere? If not,
   `NSFaceIDUsageDescription` should be removed.
