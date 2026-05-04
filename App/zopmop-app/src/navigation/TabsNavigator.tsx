// TabsNavigator — bottom-tabs container for the four main destinations
// (Home, AllServices, Bookings, Profile). Wrapped inside MainNavigator's
// native stack so detail screens (ServiceAbout, Cart, Wallet, etc.) push on
// top of whichever tab is active.
//
// Why bottom-tabs instead of stack pushes:
//   The tab bar used to navigate between tabs by pushing/popping the native
//   stack. Each switch unmounted the previous tab + slid the next in (~350ms
//   transition + full remount). Even with our in-memory caches the mount
//   churn felt slow. Bottom-tabs keeps each visited tab mounted in parallel
//   so subsequent switches are instant — no transition, no remount, no
//   skeleton flash.
//
// Tab bar:
//   `tabBar={() => null}` because the visible bar (BottomTabBar) is rendered
//   by MainNavigator's PersistentTabBar at the root level. That keeps a
//   single bar instance whose appearance/disappearance is driven by the
//   currently focused leaf route — same UX as before.
//
// Lazy mount:
//   Default `lazy: true` — first visit to a tab mounts it; subsequent
//   visits are instant. Trades a tiny first-tap cost for fast cold start.

import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import HomeScreen from '../screens/main/HomeScreen';
import AllServicesScreen from '../screens/main/AllServicesScreen';
import BookingsScreen from '../screens/main/BookingsScreen';
import ProfileScreen from '../screens/main/ProfileScreen';

export type TabsParamList = {
  Home:        undefined;
  AllServices: { instant?: boolean } | undefined;
  Bookings:    undefined;
  Profile:     undefined;
};

const Tab = createBottomTabNavigator<TabsParamList>();

export default function TabsNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: 'none' },
        sceneStyle: { backgroundColor: '#0A0A0A' },
        lazy: true,
        freezeOnBlur: true,
      }}
      tabBar={() => null}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="AllServices" component={AllServicesScreen} />
      <Tab.Screen name="Bookings" component={BookingsScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}
