import React, { useEffect } from 'react';
import { Dimensions } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import Zop from '../Zop';

const { width: SCREEN_W } = Dimensions.get('window');

type Props = {
  /** PagerView progress (0 = first slide, 1 = second slide, etc.). */
  progress: SharedValue<number>;
  /** Vertical offset within the hero area. */
  top?: number;
  /** Render layer position (absolute over carousel). */
  size?: number;
};

/**
 * Mascot rendered at the parent layer, ABOVE the PagerView. Slides out to the
 * left in lockstep with the first card so it never gets clipped by the page.
 *
 * Pop-in: hangs from above (translateY -240 → 0), rotates from -8 → -22
 * (tilted left-downward), scales 0.55 → 1, springy.
 */
export function HeroMascotOverlay({ progress, top = -56, size = 220 }: Props) {
  const ty = useSharedValue(-240);
  const rot = useSharedValue(-8);
  const sc = useSharedValue(0.55);

  useEffect(() => {
    ty.value = withDelay(140, withSpring(0, { damping: 12, stiffness: 110, mass: 1 }));
    rot.value = withDelay(
      180,
      withSequence(
        withSpring(-26, { damping: 7, stiffness: 90 }),
        withSpring(-22, { damping: 14, stiffness: 90 }),
      ),
    );
    sc.value = withDelay(140, withSpring(1, { damping: 11, stiffness: 120 }));
  }, []);

  const animStyle = useAnimatedStyle(() => {
    // Slide left + fade as user swipes from slide 0 → 1.
    const slide = interpolate(progress.value, [0, 1], [0, -SCREEN_W * 0.9], Extrapolation.CLAMP);
    const fade = interpolate(progress.value, [0, 0.7, 1], [1, 0.5, 0], Extrapolation.CLAMP);
    return {
      transform: [
        { translateX: slide },
        { translateY: ty.value },
        { rotate: `${rot.value}deg` },
        { scale: sc.value },
      ],
      opacity: fade,
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        animStyle,
        {
          position: 'absolute',
          top,
          right: -32,
          zIndex: 10,
        },
      ]}
    >
      <Zop mode="custom" size={size} autoEnter={false} />
    </Animated.View>
  );
}
