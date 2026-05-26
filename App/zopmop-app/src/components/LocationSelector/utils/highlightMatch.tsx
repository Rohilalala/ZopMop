import React from 'react';
import { Text, type TextStyle } from 'react-native';

export function highlightMatch(
  text: string,
  query: string,
  baseStyle: TextStyle,
  highlightStyle: TextStyle,
): React.ReactNode {
  if (!query.trim()) return <Text style={baseStyle}>{text}</Text>;

  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <Text style={baseStyle}>{text}</Text>;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);

  return (
    <Text style={baseStyle}>
      {before}
      <Text style={highlightStyle}>{match}</Text>
      {after}
    </Text>
  );
}
