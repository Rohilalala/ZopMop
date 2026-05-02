// GlassCard — Apple-recipe glass surface for the dark home backdrop.
// Layers (per design system spec):
//   1. vertical fill linear (white .06 → .025)         — internal light direction
//   2. inner top highlight 1px (.12 default, .22 hero)  — crisp specular edge
//   3. hairline border .5px (white .07–.12)             — sub-pixel inner stroke
//   4. drop shadow at two scales: 20px elevation + 4px contact
//
// Hero variant adds a diagonal sheen + radial inner-bloom; standard cards skip
// these (the design's `.svc` class does NOT carry sheen — only `.hero` does).

import React, { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

type Props = {
  radius?: number;
  style?: ViewStyle;
  children?: ReactNode;
  /** Extra-strong elevation + sheen (hero hero card). Default false. */
  hero?: boolean;
};

export function GlassCard({ radius = 18, style, hero = false, children }: Props) {
  return (
    <View
      style={[
        {
          borderRadius: radius,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: hero ? 20 : 8 },
          shadowOpacity: hero ? 0.5 : 0.35,
          shadowRadius: hero ? 50 : 24,
          elevation: hero ? 14 : 8,
        },
        style,
      ]}
    >
      {/* gradient fill — clipped to radius */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          borderRadius: radius,
          overflow: 'hidden',
        }}
      >
        <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
          <Defs>
            <LinearGradient id="glassFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%"   stopColor="#FFFFFF" stopOpacity="0.06" />
              <Stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.025" />
            </LinearGradient>
            {hero && (
              <>
                <LinearGradient id="glassSheen" x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0%"   stopColor="#FFFFFF" stopOpacity="0.22" />
                  <Stop offset="30%"  stopColor="#FFFFFF" stopOpacity="0.04" />
                  <Stop offset="55%"  stopColor="#FFFFFF" stopOpacity="0" />
                </LinearGradient>
                <RadialGradient
                  id="glassBloom"
                  cx="50" cy="50" rx="60" ry="60"
                  gradientUnits="userSpaceOnUse"
                >
                  <Stop offset="0%"   stopColor="#FFFFFF" stopOpacity="0" />
                  <Stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.04" />
                </RadialGradient>
              </>
            )}
          </Defs>
          <Rect width="100" height="100" fill="url(#glassFill)" />
          {hero && <Rect width="100" height="100" fill="url(#glassSheen)" />}
          {hero && <Rect width="100" height="100" fill="url(#glassBloom)" />}
        </Svg>
      </View>

      {/* hairline border */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          borderRadius: radius,
          borderWidth: 0.5,
          borderColor: hero ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.07)',
        }}
      />

      {/* No 1px inner top highlight — RN can't disperse it the way CSS
          backdrop-filter does, so it reads as a hard scan line on every
          variant (hero or otherwise). Hairline border alone is enough. */}

      {children}
    </View>
  );
}
