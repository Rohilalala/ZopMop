import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../../../theme';
import { highlightMatch } from '../utils/highlightMatch';
import type { LSThemeTokens } from '../utils/theme';
import type { PlaceResult } from '../../../api/places';

interface Props {
  result: PlaceResult;
  query: string;
  t: LSThemeTokens;
  onPress: () => void;
  isLast: boolean;
}

export function ResultRow({ result, query, t, onPress, isLast }: Props) {
  return (
    <>
      <TouchableOpacity style={s.row} onPress={onPress} activeOpacity={0.7}>
        <View style={[s.icon, { backgroundColor: t.amberFill }]}>
          <Feather name="map-pin" size={14} color={t.amber} />
        </View>
        <View style={s.body}>
          {highlightMatch(
            result.main_text,
            query,
            { ...s.main, color: t.text },
            { fontWeight: '700', color: t.amber },
          )}
          {result.secondary_text ? (
            <Text style={[s.sub, { color: t.textMuted }]} numberOfLines={1}>
              {result.secondary_text}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
      {!isLast && <View style={[s.divider, { backgroundColor: t.divider }]} />}
    </>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: 99,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  body: { flex: 1, minWidth: 0 },
  main: {
    fontFamily: FontFamily.semibold,
    fontSize: 13.5,
    letterSpacing: -0.05,
    lineHeight: 18,
  },
  sub: {
    fontFamily: FontFamily.medium,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 2,
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 30 + 12 },
});
