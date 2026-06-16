import React from 'react';
import { View, Text, type TextStyle } from 'react-native';
import { PressFx } from './PressFx';
import { useColors } from '../../context/ThemeContext';

type Props = {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  trailing?: React.ReactNode;
  large?: boolean;
  className?: string;
};

export function Header({ title, subtitle, onBack, trailing, large = false, className = '' }: Props) {
  const c = useColors();
  const titleStyle: TextStyle = {
    fontFamily: large ? 'PlusJakartaSans_700Bold' : 'PlusJakartaSans_600SemiBold',
  };
  const subStyle: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };

  return (
    <View className={`flex-row items-center px-base py-md gap-3 ${className}`}>
      {onBack && (
        <PressFx
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          className="w-10 h-10 rounded-full bg-bg-elev items-center justify-center"
        >
          <View
            style={{
              width: 9,
              height: 9,
              borderLeftWidth: 2,
              borderBottomWidth: 2,
              borderColor: c.text,
              transform: [{ rotate: '45deg' }],
              marginLeft: 4,
            }}
          />
        </PressFx>
      )}
      <View className="flex-1">
        {title && (
          <Text
            className={`${large ? 'text-2xl' : 'text-lg'} text-text`}
            style={titleStyle}
            numberOfLines={1}
          >
            {title}
          </Text>
        )}
        {subtitle && (
          <Text className="text-sm text-text-secondary" style={subStyle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing}
    </View>
  );
}
