import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';

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
    a: 'You can pay after the service is completed via UPI, card, or wallet. No advance payment required.',
  },
  {
    q: 'How do I report an issue with a service?',
    a: 'Contact our support team within 24 hours of the service and we will resolve it promptly.',
  },
];

const CONTACT_OPTIONS = [
  {
    id: 'chat',
    icon: 'chatbubble-ellipses-outline' as const,
    label: 'Live Chat',
    sublabel: 'Typically replies in under 2 mins',
    action: () => Alert.alert('Chat', 'Live chat is coming soon.'),
  },
  {
    id: 'call',
    icon: 'call-outline' as const,
    label: 'Call Us',
    sublabel: 'Mon–Sat, 9 AM – 7 PM',
    action: () => Linking.openURL('tel:+911800000000'),
  },
  {
    id: 'email',
    icon: 'mail-outline' as const,
    label: 'Email Support',
    sublabel: 'support@zopmop.com',
    action: () => Linking.openURL('mailto:support@zopmop.com'),
  },
];

export default function HelpSupportScreen() {
  const navigation = useNavigation();
  const [expanded, setExpanded] = React.useState<number | null>(null);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Help & Support</Text>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {/* Contact options */}
        <Text style={s.sectionLabel}>Contact Us</Text>
        <View style={s.listCard}>
          {CONTACT_OPTIONS.map((opt, idx) => (
            <React.Fragment key={opt.id}>
              <TouchableOpacity style={s.listRow} activeOpacity={0.7} onPress={opt.action}>
                <View style={s.iconBox}>
                  <Ionicons name={opt.icon} size={20} color={Colors.primary} />
                </View>
                <View style={s.listText}>
                  <Text style={s.listLabel}>{opt.label}</Text>
                  <Text style={s.listSub}>{opt.sublabel}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
              </TouchableOpacity>
              {idx < CONTACT_OPTIONS.length - 1 && <View style={s.divider} />}
            </React.Fragment>
          ))}
        </View>

        {/* FAQs */}
        <Text style={s.sectionLabel}>Frequently Asked Questions</Text>
        <View style={s.listCard}>
          {FAQS.map((faq, idx) => (
            <React.Fragment key={idx}>
              <TouchableOpacity
                style={s.faqRow}
                activeOpacity={0.7}
                onPress={() => setExpanded(expanded === idx ? null : idx)}
              >
                <Text style={s.faqQ} numberOfLines={expanded === idx ? undefined : 2}>
                  {faq.q}
                </Text>
                <Ionicons
                  name={expanded === idx ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={Colors.textMuted}
                />
              </TouchableOpacity>
              {expanded === idx && (
                <View style={s.faqAnswer}>
                  <Text style={s.faqA}>{faq.a}</Text>
                </View>
              )}
              {idx < FAQS.length - 1 && <View style={s.divider} />}
            </React.Fragment>
          ))}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 4,
  },
  backBtn: { padding: 4, marginLeft: -4 },
  headerTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },

  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 40 },

  sectionLabel: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 10,
    marginTop: 4,
  },

  listCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
    marginBottom: 20,
    ...Shadow.sm,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listText: { flex: 1 },
  listLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.text,
    marginBottom: 2,
  },
  listSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },

  divider: { height: 1, backgroundColor: Colors.border, marginLeft: 68 },

  faqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  faqQ: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.text,
    lineHeight: 22,
  },
  faqAnswer: {
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  faqA: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
});
