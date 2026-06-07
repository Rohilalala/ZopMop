// HeroRefreshFlyer — the pull-to-refresh mascot rendered as a top-level overlay
// (NOT inside the hero card / pager). With a hero_carousel the hero lives inside
// HeroPager's horizontal ScrollView, which CLIPS the in-card mascot as it flies
// up (it appears to go "behind" the layout). Rendering the flying mascot at the
// screen root with a high zIndex keeps the exact same easter egg — fly + spin +
// wink — driven by the same shared values + rest coords, never clipped.

import React, { useEffect } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
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
  // Idle bob — identical to HomeHero's, so the overlay's motion matches the
  // in-card mascot exactly (the fly transforms are layered on top of this).
  const float = useSharedValue(0);
  useEffect(() => {
    float.value = withRepeat(
      withTiming(1, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, []);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: transX.value },
      { translateY: -float.value * 6 + transY.value },
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
