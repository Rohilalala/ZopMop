import React, { useMemo } from 'react';
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
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';

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
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const [expanded, setExpanded] = React.useState<number | null>(null);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
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
                  <Ionicons name={opt.icon} size={20} color={c.primary} />
                </View>
                <View style={s.listText}>
                  <Text style={s.listLabel}>{opt.label}</Text>
                  <Text style={s.listSub}>{opt.sublabel}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={c.textMuted} />
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
                  color={c.textMuted}
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

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
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
      color: c.text,
      letterSpacing: -0.5,
    },

    scroll: { flex: 1 },
    content: { paddingHorizontal: 16, paddingBottom: 40 },

    sectionLabel: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.xs,
      color: c.textSecondary,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginBottom: 10,
      marginTop: 4,
    },

    listCard: {
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: c.border,
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
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    listText: { flex: 1 },
    listLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.text,
      marginBottom: 2,
    },
    listSub: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
    },

    divider: { height: 1, backgroundColor: c.border, marginLeft: 68 },

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
      color: c.text,
      lineHeight: 22,
    },
    faqAnswer: {
      paddingHorizontal: 16,
      paddingBottom: 14,
    },
    faqA: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      lineHeight: 20,
    },
  });
}
