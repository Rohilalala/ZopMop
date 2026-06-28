// ZopRefresh — pull-to-refresh visual. While `refreshing` is true, an eyeless
// Zop body spins. When refreshing transitions back to false, the face fades in
// (eyes + smile) and the whole thing pulses briefly before disappearing.
//
// Pair this with a stock <RefreshControl /> on the ScrollView (with
// tintColor="transparent" so the native spinner is hidden). The native
// gesture triggers `onRefresh`; this component owns the visual.

import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

const SIZE_DEFAULT = 56;

const STAR_PATH =
  'M178.1,26.44c1.39-5.53,10.07-5.53,11.46,0,24.18,96.14,68.9,141.13,165.61,165.5,5.53,1.39,5.53,10.05,0,11.44-96.73,24.37-141.45,69.36-165.61,165.5-1.39,5.53-10.07,5.53-11.46,0-24.18-96.14-68.9-141.15-165.59-165.5-5.53-1.39-5.53-10.05,0-11.44,96.72-24.37,141.44-69.36,165.6-165.5h-.01Z';

// Open-eye paths from zop-full.svg
const EYE_R = 'M137.45 99.4 C 133.33 109.56 125.54 136.07 127.41 160.74';
const EYE_L = 'M183.12 99.4 C 179.00 109.56 171.21 136.07 173.08 160.74';
// Default smile path from zop-full.svg
const MOUTH = 'M133.73 217.5 C 183.43 215.74 212.56 199.59 233.95 182.43';

const STROKE       = '#1F1F1F';
const STROKE_WIDTH = 13.03;

type Props = {
  refreshing: boolean;
  size?: number;
  /** Distance from the top of the overlay parent. Default 60. */
  top?: number;
};

export function ZopRefresh({ refreshing, size = SIZE_DEFAULT, top = 60 }: Props) {
  // Visibility: visible while refreshing OR while playing the post-refresh
  // smile animation. Driven by a state flag rather than the prop directly.
  const [showFace, setShowFace] = useState(false);
  const [visible,  setVisible]  = useState(false);
  const prevRefreshing = useRef(refreshing);

  // Continuous rotation while refreshing.
  const rotate = useSharedValue(0);
  // One-shot pulse for the post-refresh "smile" reveal.
  const scale  = useSharedValue(0.6);
  const opacity = useSharedValue(0);

  useEffect(() => {
    const wasRefreshing = prevRefreshing.current;

    if (refreshing) {
      setShowFace(false);
      setVisible(true);
      // Fade in + start spinning.
      opacity.value = withTiming(1, { duration: 180 });
      scale.value   = withTiming(1, { duration: 220 });
      rotate.value  = 0;
      rotate.value  = withRepeat(
        withTiming(360, { duration: 1100, easing: Easing.linear }),
        -1,
        false,
      );
    } else if (wasRefreshing) {
      // Just finished — stop spin, show face, pulse, then fade out.
      cancelAnimation(rotate);
      // Bounce home: shoot well past upright, then spring-settle with a
      // visible wobble. Target the next full 360-multiple so the motion
      // always finishes on a forward arc — no jarring back-snap.
      const current = rotate.value;
      const target = Math.ceil(current / 360) * 360;
      // First, throw past target by ~55° to load the spring, then let
      // withSpring do the oscillating settle. Low damping = wobble lives
      // long enough to read as a bounce.
      rotate.value = withSequence(
        withTiming(target + 55, { duration: 280, easing: Easing.out(Easing.cubic) }),
        withSpring(target, {
          damping: 4,
          stiffness: 110,
          mass: 0.9,
          overshootClamping: false,
        }),
      );
      setShowFace(true);
      scale.value = withSequence(
        withTiming(1.18, { duration: 260, easing: Easing.out(Easing.cubic) }),
        withSpring(1.0, {
          damping: 5,
          stiffness: 120,
          mass: 0.8,
          overshootClamping: false,
        }),
      );
      // Hold long enough for the bounce (~880ms throw + spring) before
      // fading out. Premature fade clips the wobble and kills the feel.
      const t = setTimeout(() => {
        opacity.value = withTiming(0, { duration: 260 }, (finished) => {
          if (finished) {
            // Defer state flips off the UI thread.
          }
        });
      }, 1100);
      const t2 = setTimeout(() => {
        setVisible(false);
        setShowFace(false);
      }, 1420);
      prevRefreshing.current = refreshing;
      return () => { clearTimeout(t); clearTimeout(t2); };
    } else {
      // Idle: nothing to do.
    }

    prevRefreshing.current = refreshing;
  }, [refreshing]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${rotate.value}deg` },
      { scale: scale.value },
    ],
    opacity: opacity.value,
  }));

  if (!visible) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 100,
      }}
    >
      <Animated.View style={animStyle}>
        <Svg width={size} height={size} viewBox="0 0 395.32 395.32" fill="none">
          {/* Body — always present */}
          <Path d={STAR_PATH} fill="#FFBA03" />

          {/* Face — only after refresh completes */}
          {showFace && (
            <>
              <Path
                d={EYE_R}
                stroke={STROKE}
                strokeWidth={STROKE_WIDTH}
                strokeLinecap="round"
                fill="none"
              />
              <Path
                d={EYE_L}
                stroke={STROKE}
                strokeWidth={STROKE_WIDTH}
                strokeLinecap="round"
                fill="none"
              />
              <Path
                d={MOUTH}
                stroke={STROKE}
                strokeWidth={STROKE_WIDTH}
                strokeLinecap="round"
                fill="none"
              />
            </>
          )}
        </Svg>
      </Animated.View>
    </View>
  );
}
