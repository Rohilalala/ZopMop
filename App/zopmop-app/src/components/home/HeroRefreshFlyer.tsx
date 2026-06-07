// HeroRefreshFlyer — the pull-to-refresh mascot rendered as a top-level overlay
// (NOT inside the hero card / pager). When a hero_carousel is present the hero
// lives inside HeroPager's horizontal ScrollView, which clips the in-card mascot
// as it flies up. Rendering the flying mascot at the screen root instead keeps
// the exact same easter egg (driven by the same shared values + rest coords)
// without any clipping. Mounted only while refreshing; the in-card hero mascot
// is hidden during that window so there's never a double mascot.

import React from 'react';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { ZopFlyer } from './ZopFlyer';

export function HeroRefreshFlyer({
  restX,
  restY,
  transX,
  transY,
  scale,
  rotation,
  eyeOpacity,
  winkProgress,
  showFace,
}: {
  /** Mascot centre at rest, in screen coords. */
  restX: number;
  restY: number;
  transX: SharedValue<number>;
  transY: SharedValue<number>;
  scale: SharedValue<number>;
  rotation: SharedValue<number>;
  eyeOpacity: SharedValue<number>;
  winkProgress: SharedValue<number>;
  showFace: boolean;
}) {
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: transX.value },
      { translateY: transY.value },
      { rotate: `${-12 + rotation.value}deg` }, // -12 matches the in-card resting tilt
      { scale: scale.value },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', top: restY - 65, left: restX - 65, width: 130, height: 130, zIndex: 50 },
        style,
      ]}
    >
      <ZopFlyer eyeOpacity={eyeOpacity} winkProgress={winkProgress} showFace={showFace} />
    </Animated.View>
  );
}
