// BottomTabBar — floating pill-shaped bottom nav.
//
// Visual:
//   - Floating pill (32 radius), 16px horizontal margin, 22px from bottom.
//   - SVG gradient background: dark diagonal #1F1F24 → #0F0F12 with a
//     soft amber radial glow that drifts left↔right (liquid glass sheen).
//   - 1px inner top highlight + faint white border for the glass edge.
//   - Drop shadow for depth (Android elevation + iOS shadow).
//   - Active tab: amber icon, amber-tinted rounded indicator behind it.
//   - Zop mascot protrudes above the pill centre (half-overhang) and opens
//     the Zop chat on press. Replaces the standalone amber-circle FAB.

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, type LayoutChangeEvent, type TextStyle } from 'react-native';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient as SvgRadialGradient,
  Stop,
  Rect,
} from 'react-native-svg';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { StackActions } from '@react-navigation/native';

import type { MainStackParamList } from '../../types/navigation';
import { navigationRef } from '../../navigation/navigationRef';
import { PressFx } from '../ui/PressFx';
import { haptics } from '../../utils/haptics';
import { useTheme } from '../../context/ThemeContext';
import ZopFull from '../../../assets/zop/zop-full.svg';
import ZopChat from '../ZopChat';

const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };

type IconName = React.ComponentProps<typeof Feather>['name'];

type Tab = {
  key:    'home' | 'services' | 'bookings' | 'profile';
  label:  string;
  icon:   IconName;
  screen: keyof MainStackParamList | null;
};

const TABS: Tab[] = [
  { key: 'home',     label: 'Home',     icon: 'home',         screen: 'Home' },
  { key: 'services', label: 'Services', icon: 'grid',         screen: 'AllServices' },
  { key: 'bookings', label: 'Bookings', icon: 'check-circle', screen: 'Bookings' },
  { key: 'profile',  label: 'Profile',  icon: 'user',         screen: 'Profile' },
];

const ZOP_SIZE = 64;            // visual size of the sparkle-star SVG
const ZOP_HIT  = 38;            // tap target — smaller than star bbox so the
                                // adjacent Services / Bookings tabs stay tappable
const ZOP_OVERHANG = ZOP_SIZE / 2; // half-overhang above pill top edge

type Props = {
  active: Tab['key'];
};

const INDICATOR_INSET = 6; // breathing room around the indicator pill

export function BottomTabBar({ active }: Props) {
  const { isDark } = useTheme();
  const [chatVisible, setChatVisible] = useState(false);
  // Per-tab measured layout (x relative to the row, plus width). Driven by
  // each TabItem's onLayout — so the indicator anchors to whatever rectangle
  // RN actually allocated, regardless of paddings, space-around, etc.
  const [rects, setRects] = useState<Array<{ x: number; w: number } | undefined>>(
    () => TABS.map(() => undefined),
  );
  const ready = rects.every(Boolean);

  const activeIndex = Math.max(
    0,
    TABS.findIndex((t) => t.key === active),
  );

  const indicatorX = useSharedValue(0);
  const indicatorW = useSharedValue(0);
  // Track the last animated target so we don't re-fire withSpring when the
  // same target arrives via a benign re-render (would re-start the spring
  // mid-flight and look glitchy).
  const lastTargetRef = useRef<{ x: number; w: number } | null>(null);
  const initialisedRef = useRef(false);

  const target = rects[activeIndex];
  const targetX = target ? target.x + INDICATOR_INSET : null;
  const targetW = target ? Math.max(0, target.w - INDICATOR_INSET * 2) : null;
  const targetKey = targetX !== null && targetW !== null ? `${targetX}:${targetW}` : '';

  useEffect(() => {
    if (targetX === null || targetW === null) return;
    if (
      lastTargetRef.current &&
      lastTargetRef.current.x === targetX &&
      lastTargetRef.current.w === targetW
    ) {
      return;
    }
    lastTargetRef.current = { x: targetX, w: targetW };
    if (!initialisedRef.current) {
      initialisedRef.current = true;
      indicatorX.value = targetX;
      indicatorW.value = targetW;
      return;
    }
    indicatorX.value = withSpring(targetX, {
      damping: 18,
      stiffness: 220,
      mass: 0.7,
    });
    indicatorW.value = withSpring(targetW, {
      damping: 20,
      stiffness: 240,
      mass: 0.7,
    });
  }, [targetKey, targetX, targetW, indicatorX, indicatorW]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
    width: indicatorW.value,
  }));

  const onTabLayout = (i: number) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    setRects((prev) => {
      const cur = prev[i];
      if (cur && cur.x === x && cur.w === width) return prev;
      const next = prev.slice();
      next[i] = { x, w: width };
      return next;
    });
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0, right: 0, bottom: 0,
        paddingHorizontal: 16,
        paddingBottom: 22,
        paddingTop: 8,
        zIndex: 50,
      }}
    >
      <View
        style={{
          height: 72,
          borderRadius: 36,
          overflow: 'hidden',
          borderWidth: 0.5,
          borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(13,13,15,0.06)',
          // iOS shadow
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: isDark ? 0.45 : 0.08,
          shadowRadius: isDark ? 18 : 12,
          // Android
          elevation: 14,
          backgroundColor: isDark ? '#1A1A1F' : 'rgba(255,255,255,0.75)',
        }}
      >
        {/* Static base gradient (dark only) */}
        {isDark && (
          <Svg
            width="100%"
            height="100%"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          >
            <Defs>
              <SvgLinearGradient id="navBg" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%"   stopColor="#23232A" />
                <Stop offset="100%" stopColor="#15151A" />
              </SvgLinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#navBg)" />
          </Svg>
        )}

        {/* Static centered amber glow (dark only) */}
        {isDark && (
          <Svg
            width="100%"
            height="100%"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          >
            <Defs>
              <SvgRadialGradient id="navGlow" cx="50%" cy="0%" rx="55%" ry="140%">
                <Stop offset="0%"  stopColor="#F5A300" stopOpacity="0.22" />
                <Stop offset="60%" stopColor="#F5A300" stopOpacity="0"    />
              </SvgRadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#navGlow)" />
          </Svg>
        )}

        {/* 1px inner top highlight (glass edge) */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0, left: 16, right: 16,
            height: 1,
            backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(13,13,15,0.04)',
          }}
        />

        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
          }}
        >
          {/* Animated active-tab indicator. Slides under whichever tab is
              active. Anchored to per-tab measured rects so layout quirks
              (space-around, flex distribution, paddings) can't desync it. */}
          {ready && (
            <Animated.View
              pointerEvents="none"
              style={[
                {
                  position: 'absolute',
                  top: (72 - 48) / 2,
                  height: 48,
                  borderRadius: 24,
                  backgroundColor: 'rgba(245,163,0,0.12)',
                  borderWidth: 0.5,
                  borderColor: 'rgba(245,163,0,0.28)',
                  left: 0,
                },
                indicatorStyle,
              ]}
            />
          )}

          {TABS.map((t, i) => (
            <TabItem
              key={t.key}
              tab={t}
              active={t.key === active}
              activeIndex={activeIndex}
              myIndex={i}
              isDark={isDark}
              onLayout={onTabLayout(i)}
              onPress={() => {
                if (!t.screen || t.key === active) return;
                if (!navigationRef.isReady()) return;
                haptics.light();
                // Unwind any detail screens pushed on top of Tabs, then
                // jump the bottom-tabs navigator to the requested tab.
                // Both tabs are kept mounted by TabsNavigator, so the
                // jump is instant — no animation, no remount.
                const root = navigationRef.getRootState();
                const onTopOfTabs =
                  !!root && root.routes && root.routes.length > 1 &&
                  root.routes[root.index ?? 0]?.name !== 'Tabs';
                if (onTopOfTabs) {
                  navigationRef.dispatch(StackActions.popToTop());
                }
                (navigationRef as unknown as {
                  navigate: (parent: string, params: { screen: string }) => void;
                }).navigate('Tabs', { screen: t.screen as string });
              }}
            />
          ))}
        </View>
      </View>

      {/* Zop mascot — bare sparkle-star body, half-overhang above pill centre.
          Hit area is locked to the SVG bounds so adjacent tabs (Services /
          Bookings) stay tappable. Opens chat. */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 0, right: 0,
          top: 8 - ZOP_OVERHANG,
          alignItems: 'center',
        }}
      >
        <View
          pointerEvents="box-none"
          style={{
            width: ZOP_SIZE,
            height: ZOP_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* Visual star — non-interactive so its rectangular bbox doesn't
              eat taps meant for the tabs underneath. */}
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { transform: [{ translateX: 2.75 }] }]}
          >
            <ZopFull width={ZOP_SIZE} height={ZOP_SIZE} />
          </View>
          {/* Tight central tap target. */}
          <Pressable
            onPress={() => {
              haptics.light();
              setChatVisible(true);
            }}
            style={{
              width: ZOP_HIT,
              height: ZOP_HIT,
            }}
          />
        </View>
      </View>

      <ZopChat visible={chatVisible} onClose={() => setChatVisible(false)} />
    </View>
  );
}

function TabItem({
  tab,
  active,
  activeIndex,
  myIndex,
  isDark,
  onPress,
  onLayout,
}: {
  tab: Tab;
  active: boolean;
  activeIndex: number;
  myIndex: number;
  isDark: boolean;
  onPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
}) {
  const color = active ? '#F5A300' : (isDark ? 'rgba(255,255,255,0.62)' : 'rgba(13,13,15,0.55)');

  // Per-tab pop animation: spike scale to 1.18 on becoming active, settle
  // back to 1. Inactive tabs sit at scale 1.
  const pop = useSharedValue(1);
  // Smoothed "is-active" signal — drives the label fade-in.
  const activeSig = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    if (active) {
      pop.value = withSequence(
        withTiming(1.22, { duration: 140, easing: Easing.out(Easing.cubic) }),
        withSpring(1, { damping: 12, stiffness: 240, mass: 0.6 }),
      );
    }
    activeSig.value = withTiming(active ? 1 : 0, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    });
  }, [active, pop, activeSig, activeIndex, myIndex]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pop.value }],
  }));

  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(activeSig.value, [0, 1], [0.7, 1]),
    transform: [
      { translateY: interpolate(activeSig.value, [0, 1], [2, 0]) },
    ],
  }));

  return (
    <PressFx
      onPress={onPress}
      onLayout={onLayout}
      style={{
        flex: 1,
        height: 56,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 28,
        gap: 3,
        paddingHorizontal: 6,
      }}
    >
      <Animated.View style={iconStyle}>
        <Feather name={tab.icon} size={20} color={color} />
      </Animated.View>
      <Animated.Text
        style={[fontSemi, { fontSize: 10, color, letterSpacing: 0.2 }, labelStyle]}
        numberOfLines={1}
      >
        {tab.label}
      </Animated.Text>
    </PressFx>
  );
}
