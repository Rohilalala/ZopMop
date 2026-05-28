// JobStuckScreen — Phase 1 Step 4d (State E) — the support-escape screen
// reached when a pro is stuck and the in-app OTP/payment flow cannot
// progress:
//
//   - Repeated OTP_TOO_MANY_ATTEMPTS lockout on Start or End OTP
//   - Customer refuses to pay / cannot pay
//   - PAYMENT_NOT_RESOLVED hangs indefinitely
//
// The single legitimate out is the existing CRM admin force-complete
// path (`POST /crm-api/orders/:id/mark-complete`) which lands the
// booking in completed+unpaid → triggers the existing customer block.
// The pro app NEVER calls force-complete directly; the pro calls
// support, reads the booking ID, support's CRM admin marks complete.
//
// Hard rules from the Phase 1 plan:
//   - NO cancel affordance on this screen (the backend now rejects
//     cancel from accepted+arrived and in_progress per the cancel
//     truth-table commit; this screen further hardens the UX so the
//     pro isn't even tempted to look for the wrong button).
//   - Tel only — no WhatsApp, no chat, no new deps.
//   - Booking ID displayed centrally + prominently. The pro reads
//     it to support during the call; there is no pre-fill mechanism
//     on tel: URIs.
//   - Back navigates to JobDetail. The pro can resume the OTP flow
//     if support reopens it.
//   - Both themes via useColors().

import React, { useCallback, useMemo } from 'react';
import {
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { t } from '../../i18n';
import { haptics } from '../../utils/haptics';

// Same SUPPORT_PHONE fallback used in ProProfileScreen +
// ZoneApprovalRequestScreen (the existing tel: pattern). Centralising it
// can wait; consistency with the existing surfaces matters more for now.
const SUPPORT_PHONE = process.env.EXPO_PUBLIC_SUPPORT_PHONE ?? '+918000000000';

export default function JobStuckScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<MainStackParamList, 'JobStuck'>>();
  const route = useRoute<RouteProp<MainStackParamList, 'JobStuck'>>();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const bookingID = route.params.booking_id;

  const tapCall = useCallback(() => {
    haptics.medium();
    const tel = `tel:${SUPPORT_PHONE}`;
    Linking.canOpenURL(tel).then((ok) => {
      if (ok) Linking.openURL(tel).catch(() => { /* dialer failure non-fatal */ });
    });
  }, []);

  // Surface the booking ID in a copy-friendly form. The pro reads it
  // aloud during the call; an 8-char prefix is enough for support to
  // identify the booking unambiguously (UUIDs share no common prefix
  // across customers within pilot scale).
  const shortID = bookingID.slice(0, 8);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBack}>
          <Feather name="arrow-left" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('jobStuck.headerTitle')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.body}>
        <View style={styles.iconBubble}>
          <Feather name="help-circle" size={40} color="#F5A300" />
        </View>

        <Text style={styles.title}>{t('jobStuck.title')}</Text>
        <Text style={styles.subtitle}>{t('jobStuck.subtitle')}</Text>

        {/* Booking ID — the centerpiece. Pro reads this to support
            during the call. Large monospace so digits don't blur. */}
        <View style={styles.bookingCard}>
          <Text style={styles.bookingLabel}>{t('jobStuck.bookingLabel')}</Text>
          <Text style={styles.bookingID}>#{shortID}</Text>
          <Text style={styles.bookingHelp}>{t('jobStuck.bookingHelp')}</Text>
        </View>

        {/* Primary CTA — tel: dial. Single affordance per the 4d scope. */}
        <TouchableOpacity style={styles.primaryBtn} onPress={tapCall} accessibilityRole="button">
          <Feather name="phone" size={18} color="#0D0D0F" />
          <Text style={styles.primaryBtnText}>{t('jobStuck.callSupport')}</Text>
        </TouchableOpacity>

        <Text style={styles.fineprint}>{t('jobStuck.fineprint')}</Text>
      </View>
    </SafeAreaView>
  );
}

const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: Spacing.base,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerBack: { padding: 4 },
    headerTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    headerSpacer: { width: 22 },

    body: {
      flex: 1,
      padding: Spacing.lg,
      gap: Spacing.lg,
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingTop: Spacing['2xl'],
    },

    // Big amber soft circle around the help icon — soft enough to read
    // as "support" not "error", per the 4d State E intent.
    iconBubble: {
      width: 88,
      height: 88,
      borderRadius: 44,
      backgroundColor: 'rgba(245,163,0,0.12)',
      borderWidth: 1,
      borderColor: 'rgba(245,163,0,0.28)',
      alignItems: 'center',
      justifyContent: 'center',
    },

    title: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize['xl'],
      color: c.text,
      textAlign: 'center',
    },
    subtitle: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
      maxWidth: 320,
    },

    // Booking ID card — the centerpiece. Bordered + amber-tinted so it
    // stands out as the thing the pro must read aloud.
    bookingCard: {
      width: '100%',
      maxWidth: 360,
      padding: Spacing.lg,
      borderRadius: Radius.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      gap: 6,
    },
    bookingLabel: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.xs,
      color: c.textSecondary,
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    bookingID: {
      fontFamily: MONO_FONT,
      fontWeight: '800',
      fontSize: 34,
      color: c.text,
      letterSpacing: 1.5,
    },
    bookingHelp: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textSecondary,
      textAlign: 'center',
      marginTop: 4,
    },

    // Primary CTA — single tel: call action.
    primaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      width: '100%',
      maxWidth: 360,
      paddingVertical: Spacing.base,
      borderRadius: Radius.lg,
      backgroundColor: '#F5A300',
    },
    primaryBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.lg,
      color: '#0D0D0F',
    },

    fineprint: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
      textAlign: 'center',
      maxWidth: 320,
      lineHeight: 18,
    },
  });
}
