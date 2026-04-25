import React from 'react';
import { View, Text, ScrollView, type TextStyle } from 'react-native';
import { PressFx } from '../ui/PressFx';
import type { ApiService } from '../../api/services';

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontMed: TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };

type Props = {
  services: ApiService[];
  onPress: (svc: ApiService) => void;
};

export function UsualsRow({ services, onPress }: Props) {
  if (services.length === 0) return null;

  return (
    <View style={{ marginTop: 28 }}>
      <View style={{ paddingHorizontal: 20, marginBottom: 14 }}>
        <Text style={[fontExtra, { fontSize: 26, color: '#0F172A', letterSpacing: -0.4 }]}>
          Your usuals
        </Text>
        <Text style={[fontReg, { fontSize: 13, color: '#9CA3AF', marginTop: 2 }]}>
          Book in one tap
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
      >
        {services.map((svc) => (
          <UsualCard key={svc.id} service={svc} onPress={() => onPress(svc)} />
        ))}
      </ScrollView>
    </View>
  );
}

function UsualCard({ service, onPress }: { service: ApiService; onPress: () => void }) {
  return (
    <PressFx
      onPress={onPress}
      style={{
        width: 168,
        height: 200,
        borderRadius: 22,
        backgroundColor: service.bg_color || '#EEF2FF',
        padding: 16,
        justifyContent: 'space-between',
      }}
    >
      <Text style={{ fontSize: 36 }}>{service.emoji ?? '🧹'}</Text>
      <View>
        <Text
          style={[fontBold, { fontSize: 16, color: '#0F172A', lineHeight: 20 }]}
          numberOfLines={2}
        >
          {service.name}
        </Text>
        <Text style={[fontMed, { fontSize: 12, color: '#475569', marginTop: 6 }]}>
          ₹{(service.base_price_cents / 100).toFixed(0)} · re-book
        </Text>
      </View>
    </PressFx>
  );
}
