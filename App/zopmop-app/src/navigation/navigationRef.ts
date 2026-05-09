// Module-level navigation ref so non-component code (FCM push handlers,
// background tasks, deep-link routers) can dispatch navigation actions
// without needing to be inside a screen.
//
// Usage:
//   App.tsx:           <NavigationContainer ref={navigationRef}>...
//   anywhere else:     navigationRef.current?.navigate(...)

import { createNavigationContainerRef } from '@react-navigation/native';
import type { MainStackParamList } from '../types/navigation';

export const navigationRef = createNavigationContainerRef<MainStackParamList>();

// Cold-start buffer: if navigate() is called before NavigationContainer is
// ready (e.g. getInitialNotification resolves during the auth-restore window),
// we store the call and replay it once onReady fires via flushPendingNavigation.
let _pendingNavigation: (() => void) | null = null;

export function navigate<RouteName extends keyof MainStackParamList>(
  name: RouteName,
  params?: MainStackParamList[RouteName],
) {
  if (navigationRef.isReady()) {
    // @ts-expect-error — RN navigation's overload requires literal narrowing
    // we don't enforce on this thin wrapper.
    navigationRef.navigate(name, params);
  } else {
    _pendingNavigation = () => navigate(name, params);
  }
}

/** Call this from NavigationContainer's onReady callback. */
export function flushPendingNavigation() {
  if (_pendingNavigation) {
    const fn = _pendingNavigation;
    _pendingNavigation = null;
    fn();
  }
}
