import React from 'react';
import { View, Text, type TextStyle } from 'react-native';
import { PressFx } from '../ui/PressFx';

const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };

export type Promo = {
  key: string;
  eyebrow?: string;
  title: string;
  body?: string;
  cta?: string;
  bg?: string;
  accent?: string;
  onPress?: () => void;
};

export function PromoCard({ promo }: { promo: Promo }) {
  const bg = promo.bg ?? '#EEF2FF';
  const accent = promo.accent ?? '#4F46E5';
  return (
    <View
      style={{
        flex: 1,
        marginHorizontal: 20,
        marginTop: 24,
        borderRadius: 20,
        backgroundColor: bg,
        padding: 22,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {promo.eyebrow && (
        <Text style={[fontReg, { fontSize: 12, color: accent, marginBottom: 8, letterSpacing: 1.2 }]}>
          {promo.eyebrow.toUpperCase()}
        </Text>
      )}

      <Text style={[fontExtra, { fontSize: 28, lineHeight: 32, color: '#0F172A', letterSpacing: -0.4, maxWidth: '78%' }]}>
        {promo.title}
      </Text>

      {promo.body && (
        <Text style={[fontReg, { fontSize: 14, color: '#475569', marginTop: 8, maxWidth: '78%' }]}>
          {promo.body}
        </Text>
      )}

      {promo.cta && promo.onPress && (
        <PressFx
          onPress={promo.onPress}
          style={{
            alignSelf: 'flex-start',
            marginTop: 16,
            backgroundColor: accent,
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 12,
          }}
        >
          <Text style={[fontSemi, { color: '#FFFFFF', fontSize: 13 }]}>{promo.cta}  →</Text>
        </PressFx>
      )}
    </View>
  );
}
