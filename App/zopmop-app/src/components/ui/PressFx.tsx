import React, { useCallback } from 'react';
import { Pressable, type PressableProps } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Motion } from '../../constants/tokens';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = PressableProps & {
  scale?: number;
  haptic?: boolean;
  className?: string;
};

/**
 * Wraps Pressable with a spring scale-down on press.
 * GSAP-equivalent: gsap.to(el, { scale: 0.97, duration: 0.18, ease: 'power2.out' })
 */
export function PressFx({
  children,
  scale: targetScale = 0.97,
  onPressIn,
  onPressOut,
  style,
  className,
  ...rest
}: Props) {
  const scale = useSharedValue(1);

  const handleIn = useCallback(
    (e: any) => {
      scale.value = withSpring(targetScale, Motion.spring.snappy);
      onPressIn?.(e);
    },
    [onPressIn, targetScale, scale],
  );

  const handleOut = useCallback(
    (e: any) => {
      scale.value = withTiming(1, {
        duration: Motion.duration.base,
        easing: Motion.easing.spring,
      });
      onPressOut?.(e);
    },
    [onPressOut, scale],
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPressIn={handleIn}
      onPressOut={handleOut}
      style={[animStyle, style as any]}
      className={className}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}
