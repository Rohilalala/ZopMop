import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  LayoutChangeEvent,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { C } from '../theme/screen';
import { useTheme } from '../context/ThemeContext';

// Shimmer placeholder. Base block is `C.glassHi`; a translucent linear-gradient
// band sweeps left → right on a 1200ms loop using the native driver. Sweep
// covers 2× the box width so the highlight never sits idle at the edges.
type Props = {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
};

const AView = Animated.View;
const SHIMMER_DURATION = 1200;

export function SkeletonBox({
  width,
  height = 14,
  borderRadius = 8,
  style,
}: Props) {
  const { isDark } = useTheme();
  const progress = useRef(new Animated.Value(0)).current;
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: SHIMMER_DURATION,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    if (w !== size.w || h !== size.h) setSize({ w, h });
  };

  const bandW = size.w * 1.5;
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-bandW, size.w + bandW * 0.25],
  });

  return (
    <View
      onLayout={onLayout}
      style={[
        {
          width: width as any,
          height,
          borderRadius,
          // Light: warm cream base (#F2ECE0). Dark: unchanged subtle white.
          // Note: if light result is too cold, fallback to #F2ECE0 -> #FAF7F2. Flag for Phase 4 review.
          backgroundColor: isDark ? 'rgba(255,255,255,0.035)' : '#F2ECE0',
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {size.w > 0 && size.h > 0 ? (
        <AView
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: bandW,
            height: size.h,
            transform: [{ translateX }],
          }}
        >
          <Svg width={bandW} height={size.h}>
            <Defs>
              <LinearGradient id="shimmer" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={isDark ? '#FFFFFF' : '#FFFFFF'} stopOpacity="0" />
                <Stop offset="0.5" stopColor={isDark ? '#FFFFFF' : '#FFFFFF'} stopOpacity={isDark ? '0.07' : '0.6'} />
                <Stop offset="1" stopColor={isDark ? '#FFFFFF' : '#FFFFFF'} stopOpacity="0" />
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={bandW} height={size.h} fill="url(#shimmer)" />
          </Svg>
        </AView>
      ) : null}
    </View>
  );
}

export default SkeletonBox;
