// LivePill — supply-state strip rendered between hero and presets.
//
// Three states (priority order):
//   1. Night mode (hour ≥ 20 or hour < 6): show a daily-rotating quirky
//      "pros are resting" message regardless of nearby_count. Instant booking
//      is closed at night, so the live stats would be misleading.
//   2. Daytime + nearby_count === 0: "All our pros are busy right now".
//   3. Daytime + nearby_count > 0: live stats row (count · avg rating · ETA).

import React, { useEffect } from 'react';
import { View, Text, type TextStyle } from 'react-native';
import { LoadingBars } from '../ui/LoadingBars';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';
import { liquidGlass, GlassView } from '../ui/LiquidGlass';

const fontMed: TextStyle  = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };

export type NearbyStats = {
  nearby_count: number;
  avg_rating: number;
  avg_eta_min: number;
};

type Props = {
  stats: NearbyStats | null;
  loading?: boolean;
};

// ── Time-aware copy ──────────────────────────────────────────────────────────

const NIGHT_MESSAGES = [
  'All our pros are taking it easy',
  'The pros are rebooting',
  'The pros are dream-scaping their next big move',
  'Pros are recharging — back at sunrise',
  'Pros clocked out — see you in the morning',
  "Pros are off-duty, dreaming up tomorrow's hustle",
  'Pros are tucked in — try us bright & early',
  'Even pros need beauty sleep',
  'Pros are off-shift, plotting world-class chores',
  'The mops are resting. The pros too.',
];

const NIGHT_START_HOUR = 20; // 8 pm
const NIGHT_END_HOUR   = 6;  // 6 am

function isNightTime(d = new Date()): boolean {
  const hr = d.getHours();
  return hr >= NIGHT_START_HOUR || hr < NIGHT_END_HOUR;
}

/** Stable for the whole night — rotates each calendar day. */
function nightMessage(d = new Date()): string {
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d.getTime() - start.getTime()) / 86_400_000);
  return NIGHT_MESSAGES[dayOfYear % NIGHT_MESSAGES.length];
}

// ── Layout ───────────────────────────────────────────────────────────────────

const SHELL_BASE = {
  marginHorizontal: 20,
  marginTop: 14,
  paddingHorizontal: 14,
  paddingVertical: 10,
  borderRadius: 12,
  borderWidth: 0.5,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
} as const;

function shellStyle(dark: boolean) {
  return {
    ...SHELL_BASE,
    backgroundColor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.6)',
    borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.06)',
    borderWidth: dark ? 0.5 : 1,
  } as const;
}

// Shared shell: native Liquid Glass pill on iOS 26+ — the SAME plain
// glassEffectStyle="regular" surface + drop shadow as GlassCard, so the pill
// reads identical to the hero card. The hand-built translucent shell is the
// fallback everywhere else.
//
// IMPORTANT: the glass lives on a NEVER-OPACITY-ANIMATED view. UIVisualEffectView
// inside an alpha-animated ancestor renders empty (UIKit limitation) — putting
// `entering={FadeIn}` on the shell was why the pill "vanished". Only the
// content row fades in.
function LiveShell({ dark, animated, children }: {
  dark: boolean;
  animated?: boolean;
  children: React.ReactNode;
}) {
  if (liquidGlass) {
    const { marginHorizontal, marginTop, borderRadius, ...content } = SHELL_BASE;
    const ContentWrap: React.ComponentType<any> = animated ? Animated.View : View;
    return (
      <View
        style={{
          marginHorizontal,
          marginTop,
          borderRadius,
          // GlassCard's non-hero shadow — keeps the pill's elevation language
          // identical to the cards.
          shadowColor: dark ? '#000' : 'rgba(100,60,0,1)',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: dark ? 0.25 : 0.10,
          shadowRadius: 18,
          elevation: 8,
        }}
      >
        <GlassView
          glassEffectStyle="regular"
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            borderRadius,
          }}
        />
        <ContentWrap
          {...(animated ? { entering: FadeIn.duration(420) } : {})}
          style={{ ...content, borderWidth: 0 }}
        >
          {children}
        </ContentWrap>
      </View>
    );
  }
  const Wrap: React.ComponentType<any> = animated ? Animated.View : View;
  return (
    <Wrap {...(animated ? { entering: FadeIn.duration(420) } : {})} style={shellStyle(dark)}>
      {children}
    </Wrap>
  );
}

function PulseDot({ color }: { color: string }) {
  const op = useSharedValue(1);
  useEffect(() => {
    op.value = withRepeat(
      withTiming(0.3, { duration: 800, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: op.value }));
  return (
    <Animated.View
      style={[
        style,
        {
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: color,
          shadowColor: color,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.8,
          shadowRadius: 4,
        },
      ]}
    />
  );
}

export function LivePill({ stats, loading }: Props) {
  const { isDark } = useTheme();

  const mutedTextColor = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(13,13,15,0.45)';
  const secondaryTextColor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(13,13,15,0.6)';
  const statsTextColor = isDark ? '#E3E3E3' : '#3A3A3C';
  const dotMutedColor = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(13,13,15,0.25)';
  const separatorColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(13,13,15,0.2)';

  if (loading || !stats) {
    return (
      <LiveShell dark={isDark}>
        <LoadingBars size="small" color="#F5A300" />
        <Text style={[fontMed, { fontSize: 12, color: mutedTextColor }]}>
          Checking nearby pros…
        </Text>
      </LiveShell>
    );
  }

  // Night mode wins regardless of supply count — instant booking is closed.
  if (isNightTime()) {
    return (
      <LiveShell dark={isDark} animated>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: dotMutedColor,
          }}
        />
        <Text
          style={[fontMed, { fontSize: 12, color: secondaryTextColor }]}
          numberOfLines={1}
        >
          {nightMessage()}
        </Text>
      </LiveShell>
    );
  }

  // Daytime, no supply.
  if (stats.nearby_count === 0) {
    return (
      <LiveShell dark={isDark} animated>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: dotMutedColor,
          }}
        />
        <Text
          style={[fontMed, { fontSize: 12, color: secondaryTextColor }]}
          numberOfLines={1}
        >
          All our pros are busy right now
        </Text>
      </LiveShell>
    );
  }

  // Daytime + supply available.
  return (
    <LiveShell dark={isDark} animated>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <PulseDot color="#22C55E" />
        <Text style={[fontMed, { fontSize: 12, color: statsTextColor }]}>
          <Text style={fontBold}>{stats.nearby_count} pros</Text> nearby
        </Text>
      </View>
      <Text style={{ color: separatorColor }}>·</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Text style={{ color: '#F5A300', fontSize: 12 }}>★</Text>
        <Text style={[fontMed, { fontSize: 12, color: statsTextColor }]}>
          <Text style={fontBold}>{stats.avg_rating.toFixed(1)}</Text> avg
        </Text>
      </View>
      <Text style={{ color: separatorColor }}>·</Text>
      <Text style={[fontMed, { fontSize: 12, color: statsTextColor }]}>
        ~<Text style={fontBold}>{Math.max(1, Math.round(stats.avg_eta_min))} min</Text> arrival
      </Text>
    </LiveShell>
  );
}
