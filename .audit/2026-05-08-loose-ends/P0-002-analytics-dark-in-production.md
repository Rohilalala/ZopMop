# P0-002 — Analytics dark in production builds

**Severity:** P0
**Category:** OPS
**Surfaced by:** System walkthrough Part 6
**Date:** 2026-05-08

## Finding

The mobile app's analytics layer (`src/analytics/impressionTracker.ts`) is a
stub. `logEvent()` writes to `console.info` only. There is no third-party
analytics SDK wired (no Mixpanel, Amplitude, PostHog, Segment, Firebase
Analytics, etc.).

In production builds, `babel-plugin-transform-remove-console` strips ALL
console calls. Net result: every `logEvent` call in production reaches
nowhere. Zero analytics events leave the device.

You will launch BLIND. No funnel data, no retention curves, no error rates,
no conversion metrics, no idea which sections users tap on the home screen,
no measurement of whether SDUI experiments work.

## Evidence

```bash
# Stub
cat App/zopmop-app/src/analytics/impressionTracker.ts

# Babel config strips console
cat App/zopmop-app/babel.config.js | grep -A 3 "transform-remove-console"

# Search for any real analytics SDK
grep -rn "amplitude\|mixpanel\|posthog\|@segment\|analytics()" --include="*.ts" --include="*.tsx" App/zopmop-app/src/ | head -10
```

Expected: stub file shows console.info, babel config has the strip plugin in
production, grep returns no real SDK.

## Events the app tries to log (already wired but going nowhere)

From the walkthrough:
- `sdui_section_impression` — which home sections were viewed
- `sdui_action` — which CTAs got tapped
- `sdui_render_error` — when a section failed to render
- (presumably booking funnel, payment events, etc. — not enumerated)

These events have CALL SITES already in the code. The producers exist. Only
the SINK is missing.

## Blast Radius

- **Launch week is uncalibrated.** You can't tell if your funnel is leaky.
  You can't see which services people browse vs book. You can't tell if SDUI
  experiments work. You can't see crashes.
- **Decision-making is anecdotal.** Every product call gets made on "I think
  it should work" rather than "the data says X."
- **Investor / pitch problem.** First conversation with anyone external
  ("how's user retention?") has no real answer.
- **Crash visibility is also dark.** Without Sentry/Crashlytics, JS crashes
  on real devices get lost. App stays "working" until reports trickle in via
  support.

## Reproduction

Production build of the app:
```bash
cd App/zopmop-app
eas build --profile production --platform ios
```

Open in TestFlight. Tap around. No HTTP requests visible to any analytics
domain in network logs (because there's no SDK).

Locally, you can confirm `logEvent` in dev:
```javascript
// Try this in any screen
import { logEvent } from '../analytics/impressionTracker';
logEvent('test_event', { foo: 'bar' });
// Dev: console shows it. Production: stripped, nothing happens.
```

## Fix Plan

### Option A: PostHog (recommended for ZopMop)

PostHog is open-source, has a generous free tier (1M events/month free),
covers product analytics + session replay + feature flags + experiments. Same
SDK can hook crash reporting via Sentry-compat plugin.

Why PostHog over alternatives:
- Free tier is real (1M events/mo vs Amplitude's 50K/mo cap before paid)
- React Native SDK is well-maintained
- Self-hostable later if you want data sovereignty
- Has built-in funnel analysis, retention cohorts
- Feature flags + A/B testing in same product (replaces homegrown SDUI
  experiments later if you want)

Implementation:
1. `npm install posthog-react-native`
2. Init in `App.tsx` near the top (before any provider that would emit events):
   ```typescript
   import PostHog from 'posthog-react-native';
   const posthog = new PostHog(
     process.env.EXPO_PUBLIC_POSTHOG_KEY!,
     { host: 'https://us.i.posthog.com' }
   );
   ```
3. Replace `impressionTracker.ts` `logEvent` body:
   ```typescript
   export function logEvent(name: string, props?: Record<string, any>) {
     posthog.capture(name, props);
   }
   ```
4. Wire user identity: in AuthContext after signIn, call
   `posthog.identify(user.id, { phone: user.phone, role: user.role })`.
   On signOut: `posthog.reset()`.
5. Add `EXPO_PUBLIC_POSTHOG_KEY` to `.env` and EAS secrets.

### Option B: Firebase Analytics

You already have Firebase set up for OTP. Adding analytics is "free" in
that you don't add another vendor. But Firebase Analytics is weaker for
funnel analysis vs PostHog/Mixpanel; better as a baseline than as primary.

Could pair B + future C (PostHog later when you can afford the cognitive
overhead).

### Option C: Mixpanel / Amplitude

Industry-standard. More expensive at scale than PostHog. Stronger funnel
analysis than Firebase. Pick if your eventual team is more familiar.

### Option D: Defer — launch with Firebase Analytics minimum, add real one in month 2

Bare minimum to stop being dark: Firebase Analytics. Then real product
analytics in month 2. Risky for understanding launch funnel, but cheaper.

## Recommendation

**Option A (PostHog).** Best fit for solo founder + free tier covers ZopMop's
launch volume + replaces multiple future tools (analytics + experiments +
feature flags + session replay).

Pair with **Sentry** for crash reporting (separate decision, also free tier).

## Effort

- PostHog SDK install + init: 30 min
- Replace impressionTracker stub: 15 min
- Wire user identify/reset in AuthContext: 30 min
- Audit existing call sites + add missing key events (booking_started,
  booking_paid, booking_completed, otp_sent, otp_verified): 1.5 hr
- Test in dev + verify events arrive at PostHog: 30 min
- (Optional) Sentry crash reporting: +1 hr

**Total: 2-3 hr without crash reporting; 3-4 hr with.**

## Dependencies

- PostHog account + project (free, 5 min signup)
- Decide on event taxonomy upfront — list of events + standard prop names.
  Worth 30 min of design thinking before sprinkling captures everywhere.
- Privacy policy update: PostHog collects device IDs + IPs, must disclose.
  This is fine but requires an addition to your zopmop.com/privacy page.

## Acceptance Criteria

- Dev build: events visible in PostHog dashboard within 30 sec of capture.
- Production build: same, verified via TestFlight or actual production
  release.
- Funnel chart: phone_entry → otp_sent → otp_verified → home_loaded shows
  realistic drop-off.
- Crash reporting (if Sentry added): a deliberately-thrown error in a dev
  build appears in Sentry within 1 min.
- Privacy policy at zopmop.com/privacy mentions analytics provider.

## Anchor

Pre-fix tag: `pre-fix-analytics-sdk`
