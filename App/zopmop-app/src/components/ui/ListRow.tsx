import React from 'react';
import { View, Text, type TextStyle } from 'react-native';
import { PressFx } from './PressFx';

type Props = {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  className?: string;
};

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  showChevron = true,
  className = '',
}: Props) {
  const titleStyle: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
  const subStyle: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };

  const Wrapper: any = onPress ? PressFx : View;

  return (
    <Wrapper
      onPress={onPress}
      className={`flex-row items-center px-base py-md gap-3 ${className}`}
    >
      {leading}
      <View className="flex-1">
        <Text className="text-md text-text" style={titleStyle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle && (
          <Text className="text-sm text-text-secondary mt-0.5" style={subStyle} numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing}
      {showChevron && onPress && !trailing && (
        <View
          style={{
            width: 8,
            height: 8,
            borderTopWidth: 2,
            borderRightWidth: 2,
            borderColor: '#9CA3AF',
            transform: [{ rotate: '45deg' }],
          }}
        />
      )}
    </Wrapper>
  );
}
