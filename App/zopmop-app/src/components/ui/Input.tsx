import React, { useState } from 'react';
import { TextInput, View, Text, type TextInputProps, type TextStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Motion } from '../../constants/tokens';

type Props = TextInputProps & {
  label?: string;
  error?: string;
  hint?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  containerClassName?: string;
};

export function Input({
  label,
  error,
  hint,
  leading,
  trailing,
  containerClassName = '',
  onFocus,
  onBlur,
  style,
  ...rest
}: Props) {
  const [focused, setFocused] = useState(false);
  const focus = useSharedValue(0);

  const ringStyle = useAnimatedStyle(() => ({
    borderColor: focus.value
      ? error
        ? '#DC2626'
        : '#4F46E5'
      : error
      ? '#DC2626'
      : '#E5E7EB',
  }));

  const inputStyle: TextStyle = {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 16,
    color: '#111827',
    flex: 1,
    paddingVertical: 0,
  };

  const labelStyle: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
  const helperStyle: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };

  return (
    <View className={`gap-1.5 ${containerClassName}`}>
      {label && (
        <Text className="text-sm text-text-secondary" style={labelStyle}>
          {label}
        </Text>
      )}
      <Animated.View
        style={[ringStyle, { borderWidth: 1, borderRadius: 14 }]}
        className="bg-bg-surface flex-row items-center h-14 px-base gap-2"
      >
        {leading}
        <TextInput
          {...rest}
          style={[inputStyle, style as any]}
          placeholderTextColor="#9CA3AF"
          onFocus={(e) => {
            setFocused(true);
            focus.value = withTiming(1, { duration: Motion.duration.quick });
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            focus.value = withTiming(0, { duration: Motion.duration.quick });
            onBlur?.(e);
          }}
        />
        {trailing}
      </Animated.View>
      {(error || hint) && (
        <Text
          className={`text-xs ${error ? 'text-danger' : 'text-text-muted'}`}
          style={helperStyle}
        >
          {error ?? hint}
        </Text>
      )}
    </View>
  );
}
