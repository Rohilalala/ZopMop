// LoadingBars — non-circular replacement for ActivityIndicator.
// Three narrow rounded-rect bars that pulse opacity in a 0/120/240ms stagger.
// API mirrors ActivityIndicator (size + color) so swaps stay drop-in.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

type Props = {
  size?: 'small' | 'large';
  color?: string;
  style?: StyleProp<ViewStyle>;
};

export function LoadingBars({
  size = 'small',
  color = '#FFFFFF',
  style,
}: Props) {
  const dim =
    size === 'large'
      ? { w: 4, h: 22, gap: 5 }
      : { w: 3, h: 14, gap: 4 };

  const a = useRef(new Animated.Value(0.35)).current;
  const b = useRef(new Animated.Value(0.35)).current;
  const c = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const pulse = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, {
            toValue: 1,
            duration: 360,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(val, {
            toValue: 0.35,
            duration: 360,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      );
    const x = pulse(a, 0);
    const y = pulse(b, 120);
    const z = pulse(c, 240);
    x.start();
    y.start();
    z.start();
    return () => {
      x.stop();
      y.stop();
      z.stop();
    };
  }, [a, b, c]);

  const bar = (val: Animated.Value, idx: number) => (
    <Animated.View
      key={idx}
      style={{
        width: dim.w,
        height: dim.h,
        borderRadius: dim.w / 2,
        backgroundColor: color,
        marginHorizontal: dim.gap / 2,
        opacity: val,
      }}
    />
  );

  return (
    <View style={[styles.row, style]}>
      {bar(a, 0)}
      {bar(b, 1)}
      {bar(c, 2)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default LoadingBars;
