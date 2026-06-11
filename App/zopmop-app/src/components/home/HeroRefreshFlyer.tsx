// HeroRefreshFlyer — the pull-to-refresh mascot rendered as a top-level overlay
// (NOT inside the hero card / pager). With a hero_carousel the hero lives inside
// HeroPager's horizontal ScrollView, which CLIPS the in-card mascot as it flies
// up (it appears to go "behind" the layout). Rendering the flying mascot at the
// screen root with a high zIndex keeps the exact same easter egg — fly + spin +
// wink — driven by the same shared values + rest coords, never clipped.

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
  scrollY,
  holdY,
  ride,
  eyeOpacity,
  winkProgress,
  showFace,
}: {
  /** Mascot centre at rest, in scroll-0 coords relative to the clip wrapper —
   *  a fixed point ON the hero card, not a fixed screen point. */
  restX: number;
  restY: number;
  transX: SharedValue<number>;
  transY: SharedValue<number>;
  scale: SharedValue<number>;
  rotation: SharedValue<number>;
  /** Live list scroll offset — keeps the overlay glued to the card if the user
   *  scrolls mid-animation, so the landing point is always ON the card. */
  scrollY: SharedValue<number>;
  /** The pull-to-refresh hold translate — the overlay rides the card's hold/
   *  release spring instead of step-jumping between held and rest positions. */
  holdY: SharedValue<number>;
  /** Card-ride factor, 0..1. 1 = glued to the card (launch + landing), 0 =
   *  fixed screen position (the mid-air hover in the hold gap). Without this
   *  the hover would ride the hold offset down onto the card. */
  ride: SharedValue<number>;
  eyeOpacity: SharedValue<number>;
  winkProgress: SharedValue<number>;
  showFace: boolean;
}) {
  // Pure fly — NO idle bob here. The overlay only plays the fly; it lands at the
  // exact rest (transY=0, card-anchored via holdY/scrollY) and hands back to the
  // in-card mascot, whose hover then resumes from that landing point. Adding a
  // float here started a second bob at phase 0, which read as the hover
  // "restarting" at handoff.
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: transX.value },
      // holdY - scrollY = the card's live displacement from its scroll-0 rest,
      // weighted by `ride`: glued to the card at launch/landing (ride=1) so
      // rest (transY=0) is a point ON the card, but free of the hold offset
      // mid-air (ride=0) so the hover sits in the empty gap ABOVE the card.
      { translateY: transY.value + ride.value * (holdY.value - scrollY.value) },
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
