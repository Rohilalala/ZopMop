import React from 'react';
import { View, type ViewProps } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

type Props = ViewProps & {
  edges?: Edge[];
  className?: string;
  scroll?: boolean;
  children?: React.ReactNode;
};

/**
 * Standard screen wrapper. SafeArea + bg + optional padding.
 * Use `className` to override bg or add padding (e.g. "px-base").
 */
export function ScreenContainer({
  edges = ['top', 'bottom'],
  className = '',
  children,
  ...rest
}: Props) {
  return (
    <SafeAreaView edges={edges} className={`flex-1 bg-bg ${className}`}>
      <View className="flex-1" {...rest}>
        {children}
      </View>
    </SafeAreaView>
  );
}
