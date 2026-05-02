// BottomTabBar — fixed bottom navigation matching the design's `.tabbar`.
// Mounted inside HomeScreen as an absolute-positioned layer (the app uses a
// stack navigator, not a tab navigator, so this is presentational + dispatches
// stack pushes for each tab).
//
// Design spec:
//   - Background rgba(10,10,10,.6) — near-opaque navy/dark tint, no blur
//     possible in RN, but the dark page underneath still reads correctly.
//   - 1px inset top highlight rgba(255,255,255,.06)
//   - 4 tabs (Home / Services / Bookings / Profile), 22px feather icons,
//     10px label, weight 600.
//   - Active tab: amber (#F5A300). Inactive: white .55.

import React from 'react';
import { View, Text, type TextStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { StackActions, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type { MainStackParamList } from '../../types/navigation';
import { PressFx } from '../ui/PressFx';

const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };

type IconName = React.ComponentProps<typeof Feather>['name'];

type Tab = {
  key:    'home' | 'services' | 'bookings' | 'profile';
  label:  string;
  icon:   IconName;
  /** Stack screen name — undefined = current screen, no navigation. */
  screen: keyof MainStackParamList | null;
};

const TABS: Tab[] = [
  { key: 'home',     label: 'Home',     icon: 'home',     screen: 'Home' },
  { key: 'services', label: 'Services', icon: 'grid',     screen: 'AllServices' },
  { key: 'bookings', label: 'Bookings', icon: 'check-circle', screen: 'Bookings' },
  { key: 'profile',  label: 'Profile',  icon: 'user',     screen: 'Profile' },
];

type Props = {
  active: Tab['key'];
};

export function BottomTabBar({ active }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: 10,
        paddingBottom: 28,
        paddingHorizontal: 12,
        backgroundColor: 'rgba(10,10,10,0.92)',
        borderTopWidth: 0.5,
        borderTopColor: 'rgba(255,255,255,0.08)',
        zIndex: 50,
      }}
    >
      {/* 1px inner top highlight */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: 1,
          backgroundColor: 'rgba(255,255,255,0.06)',
        }}
      />

      <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
        {TABS.map((t) => (
          <TabItem
            key={t.key}
            tab={t}
            active={t.key === active}
            onPress={() => {
              if (!t.screen || t.key === active) return;
              // Home is the stack root — pop back to it for a back-animation feel.
              if (t.key === 'home') {
                navigation.dispatch(StackActions.popToTop());
                return;
              }
              // If the target is already lower in the stack, pop back to it
              // (back-slide animation). Otherwise navigate (push). Avoids the
              // "always slides forward" bug when jumping between tabs that
              // are already mounted in the stack history.
              const state = (navigation as unknown as {
                getState: () => { routes: { name: string }[] };
              }).getState();
              const inStack = state.routes.some((r) => r.name === t.screen);
              if (inStack) {
                navigation.dispatch(StackActions.popTo(t.screen));
              } else {
                (navigation as unknown as { navigate: (s: string) => void }).navigate(t.screen);
              }
            }}
          />
        ))}
      </View>
    </View>
  );
}

function TabItem({
  tab,
  active,
  onPress,
}: {
  tab: Tab;
  active: boolean;
  onPress: () => void;
}) {
  const color = active ? '#F5A300' : 'rgba(255,255,255,0.55)';
  return (
    <PressFx
      onPress={onPress}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 6,
        paddingHorizontal: 10,
        minWidth: 56,
        gap: 3,
      }}
    >
      <Feather name={tab.icon} size={22} color={color} />
      <Text style={[fontSemi, { fontSize: 10, color }]}>{tab.label}</Text>
    </PressFx>
  );
}
