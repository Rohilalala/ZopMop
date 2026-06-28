// PaymentScreen — Cashfree Drop Checkout entry point.
//
// Reached only from CartScreen after a direct-pay booking is created
// successfully. Receives the booking id + the amount due (paise) via route
// params; from there:
//   1. POST /payments/cashfree/order to mint a Cashfree order
//   2. Hand the payment_session_id to the Cashfree Drop Checkout SDK
//   3. After SDK terminal callback, poll our backend status endpoint
//      (canonical truth — the webhook flips the ledger row)
//   4. Navigate to BookingConfirmed on success; show inline retry on
//      failure; bounce back to cart on a 502 from Cashfree.
//
// We DO NOT render a payment-method picker. The Cashfree drop sheet owns
// that UI — competing with it would just confuse users.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient as SvgRadialGradient,
  Stop,
  Rect,
} from 'react-native-svg';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type { MainStackParamList } from '../../types/navigation';
import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useC } from '../../theme/screen';
import {
  createCashfreeOrder,
  CashfreeOrderError,
} from '../../api/payments';
import {
  useCashfreePayment,
  PollAbortedError,
  PollTimeoutError,
} from '../../hooks/useCashfreePayment';
import { showError } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import { usePostHog } from 'posthog-react-native';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Nav = NativeStackNavigationProp<MainStackParamList>;
type PaymentRoute = RouteProp<MainStackParamList, 'Payment'>;

type UiState = 'idle' | 'creating_order' | 'sdk_open' | 'polling' | 'error';

export default function PaymentScreen() {
  const { isDark } = useTheme();
  const c = useC();
  const navigation = useNavigation<Nav>();
  const route = useRoute<PaymentRoute>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { startPayment, pollStatus } = useCashfreePayment();
  const posthog = usePostHog();

  // Defense against deep-link mistakes / typed-as-undefined route params.
  const params = route.params;
  useEffect(() => {
    if (!params?.booking_id || typeof params?.amount_paise !== 'number') {
      showError('Booking details missing.', { title: 'Cannot start payment' });
      navigation.goBack();
    }
  }, [params, navigation]);

  const [state, setState] = useState<UiState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // AbortSignal for pollStatus — fires on unmount so a backgrounded poll
  // doesn't hold a network call past the screen lifetime.
  const pollAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
    };
  }, []);

  const bookingID = params?.booking_id ?? '';
  const amountPaise = params?.amount_paise ?? 0;
  const bookingType = params?.bookingType ?? 'scheduled';
  // ASAP arrival promise forwarded from CartScreen — passed straight through to
  // BookingConfirmed so card/UPI ASAP bookings render "arriving by HH:MM" too.
  const etaMinutes = params?.etaMinutes;
  const helperName = params?.helperName;
  const rupees = Math.floor(amountPaise / 100);
  const decimals = (amountPaise % 100).toString().padStart(2, '0');

  const handleContinue = useCallback(async () => {
    if (!token || !bookingID) return;
    if (state === 'creating_order' || state === 'sdk_open' || state === 'polling') return;

    haptics.medium();
    setState('creating_order');
    setErrorMessage(null);
    posthog?.capture('payment_started', { booking_id: bookingID, amount_paise: amountPaise });

    let order;
    try {
      order = await createCashfreeOrder(token, {
        booking_id: bookingID,
        payment_source: 'direct',
      });
    } catch (err) {
      if (err instanceof CashfreeOrderError && err.status === 502) {
        // Per scope: 502 from createCashfreeOrder bounces to cart with toast.
        // Booking already exists; user can retry from Bookings list later.
        showError("Couldn't start payment. Try again.", {
          title: 'Payment gateway error',
        });
        navigation.goBack();
        return;
      }
      const msg =
        err instanceof CashfreeOrderError
          ? err.message
          : 'Something went wrong. Please try again.';
      setState('error');
      setErrorMessage(msg);
      return;
    }

    setState('sdk_open');
    await startPayment({
      payment_session_id: order.payment_session_id,
      order_id: order.order_id,
      on_success: async () => {
        setState('polling');
        const ctrl = new AbortController();
        pollAbortRef.current = ctrl;
        try {
          const snap = await pollStatus(order.order_id, { signal: ctrl.signal });
          if (snap.status === 'success') {
            posthog?.capture('payment_completed', { booking_id: bookingID, amount_paise: amountPaise });
            navigation.replace('BookingConfirmed', {
              bookingId: bookingID,
              totalCents: amountPaise,
              bookingType,
              ...(bookingType === 'instant' && etaMinutes != null
                ? { etaMinutes, helperName }
                : {}),
            });
            return;
          }
          if (snap.status === 'failed') {
            posthog?.capture('payment_failed', { booking_id: bookingID, amount_paise: amountPaise, reason: 'poll_failed' });
            setState('error');
            setErrorMessage('Payment failed. Try again or pick a different method.');
            return;
          }
          // 'refunded' here is unusual but possible if a refund landed
          // before our poll caught the success state.
          setState('error');
          setErrorMessage('Payment was refunded. Contact support if this is unexpected.');
        } catch (pollErr) {
          if (pollErr instanceof PollAbortedError) {
            // Screen unmounted; nothing to do.
            return;
          }
          if (pollErr instanceof PollTimeoutError) {
            // Webhook will land within a minute. Booking exists either way —
            // route to BookingConfirmed; the user can refresh Bookings to
            // see the canonical paid state.
            navigation.replace('BookingConfirmed', {
              bookingId: bookingID,
              totalCents: amountPaise,
              bookingType,
              ...(bookingType === 'instant' && etaMinutes != null
                ? { etaMinutes, helperName }
                : {}),
            });
            return;
          }
          setState('error');
          setErrorMessage("Couldn't confirm payment. Check Bookings to see status.");
        }
      },
      on_failure: (cfErr) => {
        const msg = cfErr.getMessage?.() || 'Payment failed';
        posthog?.capture('payment_failed', { booking_id: bookingID, amount_paise: amountPaise, reason: msg });
        setState('error');
        setErrorMessage(msg);
      },
    });
  }, [token, bookingID, amountPaise, bookingType, etaMinutes, helperName, state, startPayment, pollStatus, navigation, posthog]);

  const ctaDisabled =
    state === 'creating_order' ||
    state === 'sdk_open' ||
    state === 'polling';

  return (
    <View style={[s.root, { backgroundColor: c.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <ScrollView
        style={{ flex: 1, backgroundColor: 'transparent' }}
        contentContainerStyle={{ paddingBottom: 40 + insets.bottom }}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[0]}
      >
        <View style={[s.head, { paddingTop: insets.top + 10, backgroundColor: isDark ? '#0A0A0A' : c.bg }]}>
          <View style={s.headRow}>
            <PressFx
              accessibilityRole="button"
              accessibilityLabel="Go back"
              onPress={() => navigation.goBack()}
              style={[s.iconBtn, {
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.05)',
                borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(13,13,15,0.06)',
              }]}
              disabled={ctaDisabled}
            >
              <Feather name="chevron-left" size={18} color={c.text} />
            </PressFx>
            <View style={{ flex: 1 }}>
              <Text style={[s.title, { color: c.text }]}>Payment</Text>
              <Text style={[s.sub, { color: c.textMuted }]}>Secure checkout via Cashfree.</Text>
            </View>
          </View>
        </View>

        <Hero rupees={rupees} decimals={decimals} bookingID={bookingID} />

        <View style={s.body}>
          <GlassCard radius={18} style={s.infoCard}>
            <View style={s.infoRow}>
              <View style={[s.infoIcon, { backgroundColor: c.amberSoft }]}>
                <Feather name="shield" size={16} color="#F5A300" />
              </View>
              <Text style={[s.infoText, { color: c.textSecondary }]}>
                You'll be redirected to Cashfree's secure payment sheet. Returns automatically after payment.
              </Text>
            </View>
          </GlassCard>
        </View>

        {state === 'error' && errorMessage ? (
          <View style={s.body}>
            <GlassCard radius={18} style={s.errorCard}>
              <View style={s.errorRow}>
                <View style={s.errorIcon}>
                  <Feather name="alert-triangle" size={16} color="#FF8E8E" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.errorTitle}>Payment didn't go through</Text>
                  <Text style={[s.errorBody, { color: c.textSecondary }]}>{errorMessage}</Text>
                </View>
              </View>
              <PressFx
                accessibilityRole="button"
                onPress={handleContinue}
                style={s.retryCta}
              >
                <Feather name="rotate-ccw" size={14} color="#FF8E8E" />
                <Text style={s.retryCtaText}>Retry</Text>
              </PressFx>
            </GlassCard>
          </View>
        ) : null}

        {state === 'sdk_open' || state === 'polling' ? (
          <View style={s.body}>
            <View style={s.busyRow}>
              <ActivityIndicator size="small" color="#F5A300" />
              <Text style={[s.busyText, { color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(13,13,15,0.75)' }]}>
                {state === 'polling' ? 'Confirming payment…' : 'Complete payment in Cashfree to continue'}
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>

      {state === 'idle' || state === 'error' || state === 'creating_order' ? (
        <View style={[s.dock, { paddingBottom: 16 + insets.bottom, backgroundColor: isDark ? '#0A0A0A' : 'rgba(255,255,255,0.95)', borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.06)' }]}>
          <PressFx
            accessibilityRole="button"
            accessibilityLabel={`Continue to payment, ${rupees} rupees`}
            onPress={handleContinue}
            disabled={ctaDisabled}
            style={[s.cta, ctaDisabled && s.ctaBusy]}
          >
            {state === 'creating_order' ? (
              <ActivityIndicator size="small" color="#0D0D0F" />
            ) : (
              <>
                <Text style={s.ctaText}>Continue to payment</Text>
                <Feather name="chevron-right" size={18} color="#0D0D0F" />
              </>
            )}
          </PressFx>
        </View>
      ) : null}
    </View>
  );
}

function Hero({
  rupees,
  decimals,
  bookingID,
}: {
  rupees: number;
  decimals: string;
  bookingID: string;
}) {
  const { isDark } = useTheme();
  const shortID = bookingID ? bookingID.slice(0, 8) : '';
  return (
    <View style={s.heroWrap}>
      <View style={[
        s.hero,
        isDark
          ? { borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)' }
          : {
              shadowColor: '#B37100', shadowOpacity: 0.12, shadowRadius: 32, shadowOffset: { width: 0, height: 16 },
              borderWidth: 1, borderColor: 'rgba(245,163,0,0.12)',
            },
      ]}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Svg width="100%" height="100%">
            <Defs>
              <SvgLinearGradient id="payBg" x1="0" y1="0" x2="0.3" y2="1">
                <Stop offset="0%" stopColor={isDark ? '#1A1A1C' : '#FFFFFF'} />
                <Stop offset="100%" stopColor={isDark ? '#0D0D0F' : '#F7F1E8'} />
              </SvgLinearGradient>
              <SvgRadialGradient id="payGlow" cx="85%" cy="15%" rx="90%" ry="70%">
                <Stop offset="0%" stopColor="#F5A300" stopOpacity={isDark ? '0.45' : '0.25'} />
                <Stop offset="55%" stopColor="#F5A300" stopOpacity="0" />
              </SvgRadialGradient>
              <SvgRadialGradient id="payShine" cx="15%" cy="90%" rx="80%" ry="60%">
                <Stop offset="0%" stopColor={isDark ? '#FFFFFF' : '#F5A300'} stopOpacity={isDark ? '0.04' : '0.08'} />
                <Stop offset="60%" stopColor={isDark ? '#FFFFFF' : '#F5A300'} stopOpacity="0" />
              </SvgRadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#payBg)" />
            <Rect width="100%" height="100%" fill="url(#payGlow)" />
            <Rect width="100%" height="100%" fill="url(#payShine)" />
          </Svg>
        </View>

        <View style={[s.heroAmberLine, { backgroundColor: isDark ? 'rgba(245,163,0,0.4)' : 'rgba(245,163,0,0.25)' }]} pointerEvents="none" />

        <View style={s.heroTop}>
          <Text style={s.heroEyebrow}>YOU'RE PAYING</Text>
        </View>

        <View style={s.heroBody}>
          <Text style={[s.balanceCurrency, { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(13,13,15,0.50)' }]}>₹</Text>
          <Text style={[s.balanceValue, { color: isDark ? '#FFFFFF' : '#0D0D0F' }]}>{rupees.toLocaleString('en-IN')}</Text>
          <Text style={[s.balanceDecimals, { color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(13,13,15,0.35)' }]}>.{decimals}</Text>
        </View>

        {shortID ? (
          <View style={s.heroFootRow}>
            <Feather name="hash" size={11} color={isDark ? 'rgba(255,255,255,0.45)' : 'rgba(13,13,15,0.35)'} />
            <Text style={[s.heroFoot, { color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(13,13,15,0.50)' }]}>Booking {shortID}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },

  head: {
    paddingHorizontal: H_PAD,
    paddingBottom: 14,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5,
  },
  title: { ...fontExtra, fontSize: 24, letterSpacing: -0.6, lineHeight: 28 },
  sub: { ...fontMed, fontSize: 12, marginTop: 2 },

  heroWrap: { paddingHorizontal: H_PAD, paddingTop: 6 },
  hero: {
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.4, shadowRadius: 30, shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  heroAmberLine: {
    position: 'absolute', bottom: 0, left: '20%', right: '20%', height: 1,
  },
  heroTop: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 22,
  },
  heroEyebrow: {
    ...fontBold, fontSize: 10, letterSpacing: 1.6,
    color: 'rgba(245,163,0,0.95)',
  },
  heroBody: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 14 },
  balanceCurrency: {
    ...fontSemi, fontSize: 22,
    letterSpacing: -0.4,
    marginRight: 4,
  },
  balanceValue: {
    ...fontExtra, fontSize: 44,
    letterSpacing: -1.2, lineHeight: 46,
  },
  balanceDecimals: {
    ...fontSemi, fontSize: 22,
    letterSpacing: -0.4,
  },
  heroFootRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroFoot: { ...fontMed, fontSize: 11 },

  body: { paddingHorizontal: H_PAD, paddingTop: 14 },

  infoCard: { padding: 14 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  infoIcon: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  infoText: {
    flex: 1,
    ...fontMed, fontSize: 12.5,
    lineHeight: 17,
  },

  errorCard: {
    padding: 14,
    borderWidth: 0.5,
    borderColor: 'rgba(255,142,142,0.4)',
    backgroundColor: 'rgba(255,142,142,0.06)',
  },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  errorIcon: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,142,142,0.12)',
  },
  errorTitle: { ...fontBold, fontSize: 13, color: '#FF8E8E', letterSpacing: -0.1 },
  errorBody: {
    ...fontMed, fontSize: 12,
    marginTop: 4, lineHeight: 16,
  },
  retryCta: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,142,142,0.12)',
    minHeight: 44,
  },
  retryCtaText: { ...fontBold, fontSize: 13, color: '#FF8E8E' },

  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(245,163,0,0.08)',
    borderWidth: 0.5,
    borderColor: 'rgba(245,163,0,0.25)',
  },
  busyText: {
    flex: 1,
    ...fontSemi, fontSize: 12.5,
  },

  dock: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: H_PAD, paddingTop: 12,
    borderTopWidth: 0.5,
  },
  cta: {
    height: 52, minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    gap: 6,
    borderRadius: 14,
    backgroundColor: '#F5A300',
  },
  ctaBusy: { backgroundColor: 'rgba(245,163,0,0.5)' },
  ctaText: { ...fontExtra, fontSize: 15, color: '#0D0D0F', letterSpacing: -0.2 },
});
