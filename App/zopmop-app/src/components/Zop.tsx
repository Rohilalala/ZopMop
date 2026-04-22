import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import ZopFull from '../../assets/zop/zop-full.svg';
import ZopBody from '../../assets/zop/zop-body.svg';
import ZopAway from '../../assets/zop/zop-looking-away.svg';

type Mode = 'peek' | 'hero' | 'inline' | 'hugeCenter' | 'custom';

type Props = {
  mode?: Mode;
  size?: number;
  /** Shifts eyes away (crossfade to looking-away SVG) — e.g. OTP entry. */
  lookAway?: boolean;
  /** Plays entrance animation on mount. */
  autoEnter?: boolean;
  style?: ViewStyle;
  /** Override rotation (degrees). Useful in 'custom' mode. */
  rotate?: number;
};

const SCREEN_W = Dimensions.get('window').width;

/**
 * Zop — the ZopMop sparkle-star mascot.
 *
 * Modes pick a default size + rotation. For full animation control (intro
 * sequence) use `mode="custom"` and drive transforms via parent via `style`.
 */
export default function Zop({
  mode = 'inline',
  size,
  lookAway = false,
  autoEnter = true,
  style,
  rotate,
}: Props) {
  const resolvedSize =
    size ??
    (mode === 'peek'
      ? Math.min(SCREEN_W * 0.9, 380)
      : mode === 'hero'
        ? Math.min(SCREEN_W * 0.85, 360)
        : mode === 'hugeCenter'
          ? SCREEN_W * 1.1
          : 160);

  const scale = useRef(new Animated.Value(autoEnter && mode !== 'custom' ? 0 : 1)).current;
  const slide = useRef(new Animated.Value(autoEnter && mode === 'peek' ? 1 : 0)).current;
  const heroDrop = useRef(new Animated.Value(autoEnter && mode === 'hero' ? 1 : 0)).current;
  const bob = useRef(new Animated.Value(0)).current;
  const shy = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!autoEnter || mode === 'custom') return;
    const anims: Animated.CompositeAnimation[] = [];

    if (mode === 'peek') {
      anims.push(
        Animated.parallel([
          Animated.spring(scale, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }),
          Animated.spring(slide, { toValue: 0, friction: 6, tension: 70, useNativeDriver: true }),
        ]),
      );
    } else if (mode === 'hero') {
      anims.push(
        Animated.parallel([
          Animated.spring(scale, { toValue: 1, friction: 5.5, tension: 70, useNativeDriver: true }),
          Animated.spring(heroDrop, { toValue: 0, friction: 6.5, tension: 60, useNativeDriver: true }),
        ]),
      );
    } else {
      anims.push(
        Animated.spring(scale, { toValue: 1, friction: 4.5, tension: 80, useNativeDriver: true }),
      );
    }

    Animated.sequence([Animated.delay(120), ...anims]).start(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(bob, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(bob, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ).start();
    });
  }, [autoEnter, mode, scale, slide, heroDrop, bob]);

  // Smooth crossfade to looking-away face
  useEffect(() => {
    Animated.timing(shy, {
      toValue: lookAway ? 1 : 0,
      duration: 380,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [lookAway, shy]);

  const bobY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -5] });

  // Base rotation per mode
  const baseRotate =
    rotate !== undefined
      ? `${rotate}deg`
      : mode === 'peek'
        ? '-20.09deg'
        : mode === 'hero'
          ? '14.66deg'
          : '0deg';

  const peekTx = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, resolvedSize * 0.45],
  });
  const peekTy = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -resolvedSize * 0.55],
  });
  const heroTy = heroDrop.interpolate({
    inputRange: [0, 1],
    outputRange: [0, resolvedSize * 0.6],
  });

  const normalOpacity = shy.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const awayOpacity = shy.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  const transforms: any[] = [];
  if (mode === 'peek') {
    transforms.push({ translateX: peekTx });
    transforms.push({ translateY: Animated.add(peekTy, bobY) });
  } else if (mode === 'hero') {
    transforms.push({ translateY: heroTy });
  } else if (mode !== 'custom') {
    transforms.push({ translateY: bobY });
  }
  transforms.push({ scale });
  transforms.push({ rotate: baseRotate });

  return (
    <Animated.View
      pointerEvents="none"
      style={[{ width: resolvedSize, height: resolvedSize }, style, { transform: transforms }]}
    >
      {/* Base body + normal face */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: normalOpacity }]}>
        <ZopFull width={resolvedSize} height={resolvedSize} />
      </Animated.View>
      {/* Looking-away (full mascot with inverted eyes) — shown during OTP */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: awayOpacity }]}>
        <ZopAway width={resolvedSize} height={resolvedSize} />
      </Animated.View>
    </Animated.View>
  );
}

type PeekProps = Omit<Props, 'mode' | 'style'> & {
  top?: number;
  right?: number;
};

/** Pre-positioned top-right peek wrapper — drop into any onboarding screen. */
export function ZopPeek({ top = -90, right = -70, ...rest }: PeekProps) {
  return (
    <View pointerEvents="none" style={[peekStyles.wrap, { top, right }]}>
      <Zop mode="peek" {...rest} />
    </View>
  );
}

const peekStyles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    zIndex: 10,
  },
});

export { ZopBody };
