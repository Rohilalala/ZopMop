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

export function navigate<RouteName extends keyof MainStackParamList>(
  name: RouteName,
  params?: MainStackParamList[RouteName],
) {
  if (navigationRef.isReady()) {
    // @ts-expect-error — RN navigation's overload requires literal narrowing
    // we don't enforce on this thin wrapper.
    navigationRef.navigate(name, params);
  }
}
