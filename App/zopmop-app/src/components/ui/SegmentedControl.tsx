import React, { useState } from 'react';
import { View, Text, LayoutChangeEvent, type TextStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Motion } from '../../constants/tokens';
import { PressFx } from './PressFx';

type Option = { value: string; label: string };

type Props = {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

export function SegmentedControl({ options, value, onChange, className = '' }: Props) {
  const [width, setWidth] = useState(0);
  const segWidth = width ? width / options.length : 0;
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const x = useSharedValue(idx * segWidth);

  React.useEffect(() => {
    if (segWidth > 0) {
      x.value = withSpring(idx * segWidth, Motion.spring.snappy);
    }
  }, [idx, segWidth]);

  const indicator = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
    width: segWidth,
  }));

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const labelStyle: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };

  return (
    <View
      onLayout={onLayout}
      className={`relative h-11 bg-bg-elev rounded-xl p-1 flex-row ${className}`}
    >
      <Animated.View
        style={[indicator, { height: '100%' }]}
        className="absolute left-1 top-1 bottom-1 bg-bg-surface rounded-lg shadow-sm"
      />
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <PressFx
            key={opt.value}
            onPress={() => onChange(opt.value)}
            scale={0.98}
            className="flex-1 items-center justify-center"
          >
            <Text
              className={`text-sm ${active ? 'text-text' : 'text-text-secondary'}`}
              style={labelStyle}
            >
              {opt.label}
            </Text>
          </PressFx>
        );
      })}
    </View>
  );
}
