import React from 'react';
import { View, Text, type TextStyle } from 'react-native';

type Props = {
  count: number;
  max?: number;
  className?: string;
};

export function IconBadge({ count, max = 99, className = '' }: Props) {
  if (count <= 0) return null;
  const display = count > max ? `${max}+` : `${count}`;
  const style: TextStyle = {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 10,
    lineHeight: 12,
    color: '#fff',
  };
  return (
    <View
      className={`min-w-[18px] h-[18px] rounded-full bg-danger items-center justify-center px-1 ${className}`}
    >
      <Text style={style}>{display}</Text>
    </View>
  );
}
