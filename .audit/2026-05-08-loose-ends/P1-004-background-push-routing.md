# P1-004 — Background push notification taps not routed

**Severity:** P1
**Category:** UX
**Surfaced by:** System walkthrough Part 6 (push notifications section)
**Date:** 2026-05-08

## Summary

When the app is in foreground, FCM messages route correctly to the right
screen via `pushRouter.routeFcmMessage`. But when the app is in background
or killed, taps on the OS notification tray reopen the app to its default
screen (Home), not the screen relevant to the notification. A code comment
explicitly notes this as TODO. Real-world impact: a customer gets a
"matched!" push, taps it, lands on Home instead of TrackLive. Helper gets a
"new booking" push, taps it, lands on dashboard instead of the invite
screen. Both are launch-painful. Fix: wire `getInitialNotification` and
`onNotificationOpenedApp` handlers in App.tsx to route via existing
pushRouter logic. ~1.5 hr.

## Finding

The mobile app handles three notification states differently:

1. **Foreground** (app open): `messaging().onMessage()` fires, calls
   `routeFcmMessage()` which navigates to the right screen. Works.
2. **Background** (app suspended, OS shows banner): when user taps banner,
   the OS resumes the app via the deep-link handler. Should fire
   `messaging().onNotificationOpenedApp()`. Currently not wired.
3. **Quit** (app killed, OS shows banner): when user taps, OS launches the
   app fresh. Should fire `messaging().getInitialNotification()` once
   during boot. Currently not wired.

The comment in `pushRouter.ts` says:

> background taps land in the OS tray and re-open the app via the deep-link
> handler (TODO: wire in App.tsx if we add tray notifications)

Tray notifications already exist — every FCM data+notification message
shows in tray on iOS and Android. The TODO never got addressed.

Notifications affected:
- `BOOKING_INVITE` (helper) — should open ProMatchedScreen
- `SCHEDULED_INVITE` (helper) — should open ProScheduledInviteScreen
- `BOOKING_ACCEPTED` (customer) — should open TrackLive for that booking
- `BOOKING_ARRIVED` / `BOOKING_STARTED` (customer) — should open TrackLive
- `BOOKING_REBOOK_AVAILABLE` (customer) — should open the rebook flow
- `WALLET_CREDITED` (user) — should open WalletScreen
- `PAYMENT_SUCCESS` (user) — should open BookingConfirmed or relevant
  booking detail

All currently land on Home regardless.

## Evidence

```bash
grep -rn "onNotificationOpenedApp\|getInitialNotification" \
  App/zopmop-app/src/ App/zopmop-app/App.tsx 2>/dev/null

# Should return empty or only TODO comments

cat App/zopmop-app/src/utils/pushRouter.ts | grep -A 3 "TODO"
```

## Blast Radius

- **High-friction UX for the most important interactions.** Every push
  ZopMop sends is action-oriented (your booking is matched, your helper is
  arriving, etc.). Users tap pushes specifically to act. Landing on Home
  defeats the whole flow.
- **Helper-side particularly bad.** Helpers get a 25-second window to
  accept an invite. If they tap "you have a new booking" push from
  background and land on dashboard, they have to navigate manually,
  potentially missing the window. Other helpers in the parallel-invite
  pool win the booking instead.
- **Conversion impact for stealth flow.** Customer gets "your helper
  accepted" push at 11pm, taps it, goes to Home, doesn't see they're
  matched. Confused, may cancel.
- **Cancellation impact.** Customer gets "rebook available" push for a
  previously-failed search, taps it, lands on Home, doesn't realize what
  happened. Doesn't rebook.

## Reproduction

1. Send a test FCM data message with `type: "BOOKING_ACCEPTED"` to a
   logged-in user's device.
2. With app in background: tap notification banner. Observe app opens to
   Home, not TrackLive.
3. With app killed: tap notification. Same — opens to Home.
4. With app foreground: observe correct routing (foreground works).

Test FCM payload shape:
```json
{
  "data": {
    "type": "BOOKING_ACCEPTED",
    "booking_id": "<some-real-booking-id>"
  },
  "notification": {
    "title": "Helper accepted!",
    "body": "Tracking starting now"
  }
}
```

## Fix Plan

### Add two handlers in App.tsx (or push setup module)

```typescript
import messaging from '@react-native-firebase/messaging';
import { routeFcmMessage } from './src/utils/pushRouter';

// In a useEffect at the App.tsx level, after AuthProvider has mounted:

useEffect(() => {
  // Background taps (app was suspended)
  const unsubscribe = messaging().onNotificationOpenedApp(remoteMessage => {
    if (remoteMessage?.data) {
      routeFcmMessage(remoteMessage.data, navigationRef.current);
    }
  });

  // Quit-state taps (app was killed)
  messaging()
    .getInitialNotification()
    .then(remoteMessage => {
      if (remoteMessage?.data) {
        // Wait for navigation to be ready before routing
        if (navigationRef.current) {
          routeFcmMessage(remoteMessage.data, navigationRef.current);
        } else {
          // Defer until ready
          pendingInitialRouteData.current = remoteMessage.data;
        }
      }
    });

  return unsubscribe;
}, []);
```

### NavigationContainer ref pattern

The existing app uses `NavigationContainer` from React Navigation. To
navigate from outside React tree (like in a top-level useEffect), use the
ref pattern:

```typescript
import { createNavigationContainerRef } from '@react-navigation/native';
export const navigationRef = createNavigationContainerRef();

// In App.tsx:
<NavigationContainer ref={navigationRef}>
  ...
</NavigationContainer>
```

### Update routeFcmMessage to accept navigationRef

If `routeFcmMessage` currently uses `useNavigation()` hook (only works
inside React tree), refactor to accept a navigation parameter:

```typescript
export function routeFcmMessage(
  data: FcmDataPayload,
  nav: NavigationContainerRef<RootStackParamList>
) {
  if (!nav.isReady()) {
    // Buffer and retry once nav is ready
    pendingRoutes.push(data);
    return;
  }
  switch (data.type) {
    case 'BOOKING_ACCEPTED':
      nav.navigate('TrackLive', { bookingId: data.booking_id });
      break;
    case 'SCHEDULED_INVITE':
      nav.navigate('ProScheduledInvite', { bookingId: data.booking_id });
      break;
    // ... etc
  }
}
```

### Auth-gated routing

If a notification arrives for a logged-out user (rare but possible — token
revoked, user signed out on another device), the routing must check auth
state before navigating to a protected screen:

```typescript
if (!isAuthenticated) {
  // Defer to after login — buffer the route, replay after sign-in
  pendingPostLoginRoute.current = { screen, params };
  return;
}
```

### Cold-start race condition

`getInitialNotification` resolves before `NavigationContainer` is ready.
Two options:
- (A) Buffer the initial route, replay after `onReady` callback fires
- (B) Wait for `navigationRef.isReady()` in a poll

(A) is cleaner. Implement with a useRef + useEffect that fires after
NavigationContainer mounts.

## Recommendation

Implement all 3 cases (foreground works, add background + quit). Add
auth-gating. Add cold-start buffer. Test all three states for at least 4
notification types (BOOKING_ACCEPTED, SCHEDULED_INVITE,
BOOKING_REBOOK_AVAILABLE, WALLET_CREDITED).

## Effort

- Refactor pushRouter to accept nav ref: 30 min
- Wire onNotificationOpenedApp + getInitialNotification: 30 min
- Cold-start buffer + auth-gate: 30 min
- Manual test all 3 states × 4 notification types: 1 hr (includes building
  test FCM payloads, reinstalling app)

**Total: ~2.5 hr.**

## Dependencies

- None blocking
- Will benefit from P0-002 (analytics) being live — push tap analytics
  reveal whether routing actually delivers users to the intended screen

## Acceptance Criteria

- Foreground push: routes correctly (existing behavior, regression-test)
- Background push: tapping banner opens correct screen with correct params
- Quit-state push: cold launch + tap goes to correct screen, not Home
- Logged-out user receiving a push: lands on PhoneEntry, the intended
  route is replayed after login
- Cold-start race: tested with airplane-mode + reopen scenarios

## Anchor

Pre-fix tag: `pre-fix-background-push-routing`
