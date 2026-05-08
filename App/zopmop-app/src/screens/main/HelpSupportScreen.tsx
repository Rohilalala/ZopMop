// HelpSupportScreen — dark home pattern.
// Layout: Bloom backdrop → sticky header (back + title + sub) → contact list
// (GlassCard) → FAQ list (GlassCard, expandable rows).

import React, { useState } from 'react';
import {
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

const FAQS = [
  {
    q: 'How do I reschedule a booking?',
    a: 'Go to My Bookings, tap the booking you want to change, and select Reschedule.',
  },
  {
    q: 'What is the cancellation policy?',
    a: 'Free cancellation up to 2 hours before the scheduled time. Late cancellations may incur a fee.',
  },
  {
    q: 'How are payments handled?',
    a: 'Pay after the service is completed via UPI, card, or wallet. No advance payment required.',
  },
  {
    q: 'How do I report an issue with a service?',
    a: 'Contact support within 24 hours of the service and we will resolve it promptly.',
  },
];

type ContactOption = {
  id: string;
  icon: keyof typeof Feather.glyphMap;
  label: string;
  sublabel: string;
  action: () => void;
};

// Live chat (S25) and call-us (S24) rows are hidden until ops issues a real
// support number and a chat vendor is wired. Email is the canonical support
// channel today; restore the other rows when their backends ship.
const CONTACT_OPTIONS: ContactOption[] = [
  {
    id: 'email',
    icon: 'mail',
    label: 'Email support',
    sublabel: 'support@zopmop.com',
    action: () => Linking.openURL('mailto:support@zopmop.com'),
  },
];

export default function HelpSupportScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <Bloom />

      <ScrollView
        style={{ flex: 1, backgroundColor: 'transparent' }}
        contentContainerStyle={{ paddingBottom: 60 + insets.bottom }}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[0]}
      >
        <View style={[s.head, { paddingTop: insets.top + 10 }]}>
          <View style={s.headRow}>
            <PressFx
              onPress={() => navigation.goBack()}
              style={s.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <Feather name="chevron-left" size={18} color="#FFFFFF" />
            </PressFx>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>Help & support</Text>
              <Text style={s.sub}>We're here when you need us.</Text>
            </View>
          </View>
        </View>

        <Text style={s.secH}>Contact us</Text>
        <View style={s.body}>
          <GlassCard radius={20} style={s.card}>
            {CONTACT_OPTIONS.map((opt, idx) => (
              <React.Fragment key={opt.id}>
                <PressFx onPress={opt.action} style={s.row}>
                  <View style={s.rowIcon}>
                    <Feather name={opt.icon} size={18} color="#F5A300" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowTitle}>{opt.label}</Text>
                    <Text style={s.rowSub}>{opt.sublabel}</Text>
                  </View>
                  <Feather name="chevron-right" size={16} color="rgba(255,255,255,0.35)" />
                </PressFx>
                {idx < CONTACT_OPTIONS.length - 1 && <View style={s.divider} />}
              </React.Fragment>
            ))}
          </GlassCard>
        </View>

        <Text style={s.secH}>Frequently asked</Text>
        <View style={s.body}>
          <GlassCard radius={20} style={s.card}>
            {FAQS.map((faq, idx) => {
              const open = expanded === idx;
              return (
                <React.Fragment key={idx}>
                  <PressFx
                    onPress={() => setExpanded(open ? null : idx)}
                    style={s.faqRow}
                  >
                    <Text style={s.faqQ} numberOfLines={open ? undefined : 2}>
                      {faq.q}
                    </Text>
                    <Feather
                      name={open ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color="rgba(255,255,255,0.45)"
                    />
                  </PressFx>
                  {open && (
                    <View style={s.faqAnswer}>
                      <Text style={s.faqA}>{faq.a}</Text>
                    </View>
                  )}
                  {idx < FAQS.length - 1 && <View style={s.divider} />}
                </React.Fragment>
              );
            })}
          </GlassCard>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },

  // Sticky head
  head: {
    backgroundColor: '#0A0A0A',
    paddingHorizontal: H_PAD,
    paddingBottom: 14,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
  },
  title: {
    ...fontExtra,
    fontSize: 24,
    color: '#FFFFFF',
    letterSpacing: -0.6,
    lineHeight: 28,
  },
  sub: {
    ...fontMed,
    fontSize: 12,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },

  // Section header
  secH: {
    ...fontBold,
    fontSize: 11,
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    paddingHorizontal: H_PAD + 4,
    paddingTop: 22,
    paddingBottom: 10,
  },

  body: { paddingHorizontal: H_PAD },

  card: { padding: 8 },

  // Contact row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  rowIcon: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.12)',
  },
  rowTitle: {
    ...fontSemi,
    fontSize: 14,
    color: '#FFFFFF',
    letterSpacing: -0.1,
  },
  rowSub: {
    ...fontMed,
    fontSize: 11.5,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginHorizontal: 10,
  },

  // FAQ row
  faqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  faqQ: {
    flex: 1,
    ...fontSemi,
    fontSize: 13.5,
    color: '#FFFFFF',
    lineHeight: 19,
  },
  faqAnswer: {
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  faqA: {
    ...fontMed,
    fontSize: 13,
    color: 'rgba(255,255,255,0.65)',
    lineHeight: 19,
  },
});
