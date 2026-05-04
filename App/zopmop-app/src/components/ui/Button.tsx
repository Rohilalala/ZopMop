import React from 'react';
import { Text, View, type TextStyle } from 'react-native';
import { LoadingBars } from './LoadingBars';
import { PressFx } from './PressFx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

type Props = {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
  textClassName?: string;
};

const containerByVariant: Record<Variant, string> = {
  primary: 'bg-primary',
  secondary: 'bg-primary-bg',
  ghost: 'bg-transparent',
  danger: 'bg-danger',
  outline: 'bg-bg-surface border border-border-strong',
};

const textColorByVariant: Record<Variant, string> = {
  primary: 'text-text-inverse',
  secondary: 'text-primary',
  ghost: 'text-primary',
  danger: 'text-text-inverse',
  outline: 'text-text',
};

const sizeMap: Record<Size, { h: string; pad: string; text: string; radius: string }> = {
  sm: { h: 'h-10', pad: 'px-base', text: 'text-sm', radius: 'rounded-lg' },
  md: { h: 'h-12', pad: 'px-lg', text: 'text-md', radius: 'rounded-xl' },
  lg: { h: 'h-14', pad: 'px-xl', text: 'text-md', radius: 'rounded-xl' },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  loading = false,
  disabled = false,
  fullWidth = true,
  leading,
  trailing,
  className = '',
  textClassName = '',
}: Props) {
  const sz = sizeMap[size];
  const isDisabled = disabled || loading;

  const containerCls =
    `${sz.h} ${sz.pad} ${sz.radius} ${containerByVariant[variant]} ` +
    `${fullWidth ? 'w-full' : ''} ` +
    `flex-row items-center justify-center ` +
    `${isDisabled ? 'opacity-60' : ''} ` +
    className;

  const labelStyle: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };

  return (
    <PressFx
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      className={containerCls}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
    >
      {loading ? (
        <LoadingBars color={variant === 'primary' || variant === 'danger' ? '#fff' : '#4F46E5'} />
      ) : (
        <View className="flex-row items-center justify-center gap-2">
          {leading}
          <Text
            className={`${sz.text} ${textColorByVariant[variant]} ${textClassName}`}
            style={labelStyle}
          >
            {label}
          </Text>
          {trailing}
        </View>
      )}
    </PressFx>
  );
}
