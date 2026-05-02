// Bloom — off-screen amber radial that gives glass surfaces something quiet
// to refract on the dark home background. Three layered radials:
//   1. warm amber from top-right (primary glow)
//   2. faint white from top-left (cool fill)
//   3. amber long-tail extending down-screen so the warmth bleeds into the
//      feed rather than getting trapped in the header strip
// Mirrors the design's `.screen.dark::before` recipe with one extra long-tail
// stop because we don't have a parent backdrop-filter to disperse the light.

import React from 'react';
import { Dimensions, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export function Bloom() {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: -60,
        left: 0,
        right: 0,
        height: SCREEN_H + 60,
      }}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${SCREEN_W} ${SCREEN_H + 60}`}
      >
        <Defs>
          {/* Top-right amber bloom — main accent. Wider + taller so it bleeds
              well past the header into the hero + first cards. */}
          <RadialGradient
            id="amberMain"
            cx={SCREEN_W * 0.95}
            cy={-SCREEN_H * 0.08}
            rx={SCREEN_W * 1.10}
            ry={SCREEN_H * 0.65}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#F5A300" stopOpacity="0.22" />
            <Stop offset="40%" stopColor="#F5A300" stopOpacity="0.08" />
            <Stop offset="70%" stopColor="#F5A300" stopOpacity="0" />
          </RadialGradient>

          {/* Top-left cool fill — keeps page from feeling lopsided. */}
          <RadialGradient
            id="whiteFill"
            cx={-SCREEN_W * 0.10}
            cy={SCREEN_H * 0.12}
            rx={SCREEN_W * 0.80}
            ry={SCREEN_H * 0.55}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#FFFFFF" stopOpacity="0.05" />
            <Stop offset="60%" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>

          {/* Long-tail amber drifting down-right — a quiet, low-opacity warmth
              under the feed. Without this the header looks "stuck" with all
              the colour while the feed below reads as flat black. */}
          <RadialGradient
            id="amberTail"
            cx={SCREEN_W * 0.85}
            cy={SCREEN_H * 0.40}
            rx={SCREEN_W * 0.95}
            ry={SCREEN_H * 0.55}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%"  stopColor="#F5A300" stopOpacity="0.06" />
            <Stop offset="60%" stopColor="#F5A300" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#amberMain)" />
        <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#amberTail)" />
        <Rect width={SCREEN_W} height={SCREEN_H + 60} fill="url(#whiteFill)" />
      </Svg>
    </View>
  );
}
