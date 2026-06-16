// SuccessBackdrop — the green + amber radial glow behind success states.
// Extracted from BookingConfirmedScreen so every screen that shows the shared
// SuccessTick (booking confirmed, TrackLive's service-complete) carries the
// same backdrop. Dark: near-black base + green crown + amber side glow.
// Light: cream base gradient + the same two radials, slightly stronger.

import React from 'react';
import { Dimensions, View } from 'react-native';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export function SuccessBackdrop({ isDark }: { isDark: boolean }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: SCREEN_H,
      }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${SCREEN_W} ${SCREEN_H}`}>
        <Defs>
          {/* Light mode: cream base gradient */}
          {!isDark && (
            <SvgLinearGradient id="creamBase" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#FAF7F2" />
              <Stop offset="0.6" stopColor="#F4EFE7" />
              <Stop offset="1" stopColor="#EFE9DE" />
            </SvgLinearGradient>
          )}
          <RadialGradient
            id="green"
            cx={SCREEN_W / 2} cy={-SCREEN_H * 0.10}
            rx={isDark ? SCREEN_W * 0.80 : SCREEN_W * 1.10}
            ry={isDark ? SCREEN_H * 0.50 : SCREEN_H * 0.60}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#22C55E" stopOpacity={isDark ? '0.22' : '0.30'} />
            <Stop offset="55%" stopColor="#22C55E" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient
            id="amber"
            cx={isDark ? SCREEN_W * 1.0 : SCREEN_W * 1.10}
            cy={SCREEN_H * 0.30}
            rx={isDark ? SCREEN_W * 0.70 : SCREEN_W * 1.10}
            ry={isDark ? SCREEN_H * 0.50 : SCREEN_H * 0.70}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#F5A300" stopOpacity={isDark ? '0.18' : '0.20'} />
            <Stop offset={isDark ? '55%' : '50%'} stopColor="#F5A300" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect width={SCREEN_W} height={SCREEN_H} fill={isDark ? '#0A0A0A' : 'url(#creamBase)'} />
        <Rect width={SCREEN_W} height={SCREEN_H} fill="url(#green)" />
        <Rect width={SCREEN_W} height={SCREEN_H} fill="url(#amber)" />
      </Svg>
    </View>
  );
}
