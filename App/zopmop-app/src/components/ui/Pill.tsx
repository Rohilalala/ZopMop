import React from 'react';
import { View, Text, type TextStyle } from 'react-native';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'mascot';
type Size = 'sm' | 'md';

type Props = {
  label: string;
  tone?: Tone;
  size?: Size;
  leading?: React.ReactNode;
  className?: string;
};

const toneCls: Record<Tone, { bg: string; text: string }> = {
  neutral: { bg: 'bg-bg-elev', text: 'text-text-secondary' },
  primary: { bg: 'bg-primary-bg', text: 'text-primary' },
  success: { bg: 'bg-success-bg', text: 'text-success' },
  warning: { bg: 'bg-warning-bg', text: 'text-warning' },
  danger: { bg: 'bg-danger-bg', text: 'text-danger' },
  info: { bg: 'bg-info-bg', text: 'text-info' },
  mascot: { bg: 'bg-mascot-50', text: 'text-mascot-dark' },
};

const sizeCls: Record<Size, { box: string; text: string }> = {
  sm: { box: 'px-2 py-0.5 rounded-full', text: 'text-xs' },
  md: { box: 'px-3 py-1 rounded-full', text: 'text-sm' },
};

export function Pill({ label, tone = 'neutral', size = 'sm', leading, className = '' }: Props) {
  const t = toneCls[tone];
  const s = sizeCls[size];
  const labelStyle: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
  return (
    <View className={`flex-row items-center gap-1 ${s.box} ${t.bg} ${className}`}>
      {leading}
      <Text className={`${s.text} ${t.text}`} style={labelStyle}>
        {label}
      </Text>
    </View>
  );
}
