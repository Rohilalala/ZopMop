// TabsNavigator — the four main destinations (Home, AllServices, Bookings,
// Profile), wrapped inside MainNavigator's native stack.
//
// Platform split (per the "native on iOS, custom on Android" direction):
//   iOS     → real native UITabBar via react-native-bottom-tabs
//             (genuine liquid-glass tab bar on iOS 26, SF-Symbol icons).
//   Android → the existing custom setup: a hidden JS tab bar here, with the
//             branded BottomTabBar drawn by MainNavigator's PersistentTabBar.
//
// On iOS the native bar is the only bar, so PersistentTabBar renders nothing
// there (guarded in MainNavigator).

import React from 'react';
import { Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeBottomTabNavigator } from '@bottom-tabs/react-navigation';

import HomeScreen from '../screens/main/HomeScreen';
import AllServicesScreen from '../screens/main/AllServicesScreen';
import BookingsScreen from '../screens/main/BookingsScreen';
import ProfileScreen from '../screens/main/ProfileScreen';
import { useTheme } from '../context/ThemeContext';

export type TabsParamList = {
  Home:        undefined;
  AllServices: undefined;
  Bookings:    undefined;
  Profile:     undefined;
  Zop:         undefined;
};

const Tab = createBottomTabNavigator<TabsParamList>();
const NativeTab = createNativeBottomTabNavigator<TabsParamList>();

// iOS — the genuine system tab bar (translucent / liquid-glass material).
// Tabs: Home · Services · Bookings · Profile. Zop is NOT a tab — it's the
// mascot floating over the bar centre (IosZopButton in MainNavigator), an
// independent overlay so opening the chat doesn't switch scenes / black out.
function IosNativeTabs() {
  const { isDark } = useTheme();
  return (
    <NativeTab.Navigator
      tabBarActiveTintColor="#F5A300"
      tabBarInactiveTintColor={isDark ? 'rgba(255,255,255,0.55)' : 'rgba(13,13,15,0.5)'}
      // Tint the bar to the app theme so it stays dark in dark mode (the native
      // bar would otherwise follow the device appearance).
      tabBarStyle={{ backgroundColor: isDark ? '#101012' : '#FFFFFF' }}
      translucent
      hapticFeedbackEnabled
    >
      <NativeTab.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: 'Home', tabBarIcon: () => ({ sfSymbol: 'house.fill' }) }}
      />
      <NativeTab.Screen
        name="AllServices"
        component={AllServicesScreen}
        options={{ title: 'Services', tabBarIcon: () => ({ sfSymbol: 'square.grid.2x2.fill' }) }}
      />
      <NativeTab.Screen
        name="Bookings"
        component={BookingsScreen}
        options={{ title: 'Bookings', tabBarIcon: () => ({ sfSymbol: 'calendar' }) }}
      />
      <NativeTab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ title: 'Profile', tabBarIcon: () => ({ sfSymbol: 'person.fill' }) }}
      />
    </NativeTab.Navigator>
  );
}

// Android — hidden JS tab bar; the visible branded bar is PersistentTabBar.
function AndroidCustomTabs() {
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

export default function TabsNavigator() {
  return Platform.OS === 'ios' ? <IosNativeTabs /> : <AndroidCustomTabs />;
}
