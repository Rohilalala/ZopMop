import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { useColors } from '../../context/ThemeContext';

export default function BookingConfirmedScreen({ route, navigation }: any) {
  const c = useColors();
  const { bookingId, totalCents, slot, addressLine } = route.params || {};
  return (
    <SafeAreaView style={[s.wrap, { backgroundColor: c.background }]}>
      <View style={s.body}>
        <Text style={s.emoji}>✅</Text>
        <Text style={[s.title, { color: c.text }]}>Booking confirmed</Text>
        <Text style={[s.sub, { color: c.textSecondary }]}>We've sent the request to nearby pros.</Text>
        <View style={[s.card, { backgroundColor: c.white, borderColor: c.border }]}>
          <Row label="Booking ID" value={`ZM-${(bookingId || '').slice(0, 8).toUpperCase()}`} c={c} />
          {slot && <Row label="When" value={slot} c={c} />}
          {addressLine && <Row label="Where" value={addressLine} c={c} />}
          <Row label="Total" value={`₹${((totalCents || 0) / 100).toFixed(0)}`} c={c} />
        </View>
      </View>
      <View style={s.ctaWrap}>
        <TouchableOpacity
          style={[s.cta, { backgroundColor: c.primary }]}
          onPress={() => navigation.navigate('Bookings')}
          accessibilityRole="button">
          <Text style={s.ctaText}>View booking</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.secondary}
          onPress={() => navigation.navigate('Home')}
          accessibilityRole="button">
          <Text style={[s.secondaryText, { color: c.textSecondary }]}>Back to home</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function Row({ label, value, c }: any) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLabel, { color: c.textSecondary }]}>{label}</Text>
      <Text style={[s.rowValue, { color: c.text }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1 },
  body: { flex: 1, padding: 24, justifyContent: 'center' },
  emoji: { fontSize: 64, textAlign: 'center', marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  sub: { fontSize: 16, textAlign: 'center', marginBottom: 32 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 20 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 14, fontWeight: '600' },
  ctaWrap: { padding: 24, gap: 12 },
  cta: { paddingVertical: 16, borderRadius: 14, alignItems: 'center' },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondary: { paddingVertical: 12, alignItems: 'center' },
  secondaryText: { fontSize: 14 },
});
