import React from 'react';
import { View, type ViewProps } from 'react-native';
import { Shadow } from '../../constants/tokens';
import { PressFx } from './PressFx';

type Variant = 'elevated' | 'flat' | 'outline';

type Props = ViewProps & {
  variant?: Variant;
  onPress?: () => void;
  className?: string;
  children?: React.ReactNode;
};

const variantCls: Record<Variant, string> = {
  elevated: 'bg-bg-surface',
  flat: 'bg-bg-elev',
  outline: 'bg-bg-surface border border-border',
};

export function Card({
  variant = 'elevated',
  onPress,
  className = '',
  style,
  children,
  ...rest
}: Props) {
  const cls = `rounded-xl p-base ${variantCls[variant]} ${className}`;
  const elevation = variant === 'elevated' ? Shadow.sm : undefined;

  if (onPress) {
    return (
      <PressFx onPress={onPress} className={cls} style={[elevation, style as any]}>
        {children}
      </PressFx>
    );
  }
  return (
    <View className={cls} style={[elevation, style as any]} {...rest}>
      {children}
    </View>
  );
}
