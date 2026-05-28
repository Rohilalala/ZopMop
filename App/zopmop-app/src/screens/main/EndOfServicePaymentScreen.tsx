// EndOfServicePaymentScreen — Phase 1 Step 5d hosts the end-of-service
// payment-method choice modal. Renders States 1 (choose), 2 (cash
// confirmation popup), 3 (opening Cashfree), 5 (failed).
//
// States 4a (cash) + 4b (paid online) DO NOT live here — they're
// stable post-resolution displays that render INLINE on TrackLive
// next to the pro / map sheet. Reaching them closes this modal.
//
// 5d.1 — UI SHELLS ONLY. No real payment calls; the screen exposes
// dev toggles at the bottom that drive the local state machine so
// sim review can walk all five states. 5d.2 wires the real Cashfree
// drop sheet + POST /bookings/:id/resolve-cash + lock-rule guards.
//
// Hardcoded dark tokens match the surrounding TrackLive surfaces
// (light mode lives on the unmerged appearance-toast branch; whole-
// screen migration happens when that lands).

import React, { useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextStyle,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from 'react-native-svg';

import type { MainStackParamList } from '../../types/navigation';

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontMed: TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontMono: TextStyle = {
  fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
};

const AMBER = '#F5A300';
const AMBER_HI = '#FFC042';
const AMBER_LO = '#E88F00';
const INK = '#0D0D0F';
const GREEN = '#22C55E';

// LocalState — drives the modal's view. 4a / 4b are NOT here because
// reaching them closes the modal and TrackLive renders inline.
type LocalState = 'choose' | 'cash_confirm' | 'opening' | 'failed';

export default function EndOfServicePaymentScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<MainStackParamList, 'EndOfServicePayment'>>();
  const route = useRoute<RouteProp<MainStackParamList, 'EndOfServicePayment'>>();
  const { bookingId, amountPaise, helperName } = route.params;

  // Local UI state machine. 5d.2 will wire real triggers; 5d.1 uses
  // dev toggles to walk every state.
  const [state, setState] = useState<LocalState>('choose');

  const amountRupees = Math.round((amountPaise ?? 0) / 100);
  const proFirstName = (helperName ?? 'your pro').split(' ')[0];

  // Navigation handlers.
  const close = () => navigation.goBack();

  // 5d.1 mock handlers — 5d.2 replaces these with real calls.
  const tapPayOnline = () => setState('opening');
  const tapPayCashInstead = () => setState('cash_confirm');
  const tapYesPayCash = () => {
    // Mock: success → close (TrackLive will pick up cash_collected_at
    // on next push tick and render State 4a inline). Real flow in 5d.2
    // calls POST /bookings/:id/resolve-cash here.
    close();
  };
  const tapPayOnlineInsteadFromPopup = () => {
    setState('opening');
  };
  const tapTryAgainFromFailure = () => setState('opening');
  const tapCashInsteadFromFailure = () => {
    // CRITICAL: from State 5 the cash fallback is offered cleanly
    // WITHOUT the State-2 nudge-back popup. Online already failed;
    // cash is the legitimate fallback. 5d.2 calls resolveCash
    // directly here (with retry-on-ONLINE_PAYMENT_PENDING for the
    // residual webhook-lag race documented in the planning gate).
    close();
  };

  // Mock dev toggle — 5d.1 only. Walks every state for sim review.
  // Will be deleted before the final 5d push.
  const DevStateToggles = () => (
    <View style={s.devToggleRow}>
      <Text style={[fontReg, s.devToggleLabel]}>DEV:</Text>
      {(['choose', 'cash_confirm', 'opening', 'failed'] as LocalState[]).map((k) => (
        <TouchableOpacity
          key={k}
          onPress={() => setState(k)}
          style={[s.devTogglePill, state === k && s.devTogglePillActive]}
        >
          <Text style={[fontMed, s.devTogglePillText]}>{k}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />

      {/* HEADER (close + minimal title) */}
      <View style={s.header}>
        <Pressable onPress={close} style={s.headerClose}>
          <Feather name="x" size={22} color="#FFFFFF" />
        </Pressable>
        <View style={s.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={s.body}>
        {state === 'choose' && (
          <ChooseState
            amountRupees={amountRupees}
            onPayOnline={tapPayOnline}
            onPayCash={tapPayCashInstead}
          />
        )}
        {state === 'opening' && <OpeningState amountRupees={amountRupees} />}
        {state === 'failed' && (
          <FailedState
            amountRupees={amountRupees}
            onTryAgain={tapTryAgainFromFailure}
            onCashInstead={tapCashInsteadFromFailure}
          />
        )}

        {/* 5d.1 — dev toggles. Removed before final 5d push. */}
        {__DEV__ && <DevStateToggles />}
      </ScrollView>

      {/* Cash confirmation popup overlays the choose state. Renders
          on top of whatever is below. */}
      {state === 'cash_confirm' && (
        <CashConfirmPopup
          amountRupees={amountRupees}
          proFirstName={proFirstName}
          onPayOnlineInstead={tapPayOnlineInsteadFromPopup}
          onYesPayCash={tapYesPayCash}
          onDismiss={() => setState('choose')}
        />
      )}
    </SafeAreaView>
  );
}

// ───────────────────────────────────────────────────────────────────
// STATE 1 — Choose how to pay
// ───────────────────────────────────────────────────────────────────

function ChooseState({
  amountRupees,
  onPayOnline,
  onPayCash,
}: {
  amountRupees: number;
  onPayOnline: () => void;
  onPayCash: () => void;
}) {
  return (
    <View style={s.chooseWrap}>
      <View style={s.completeIcon}>
        <Feather name="check" size={28} color={INK} />
      </View>
      <Text style={[fontExtra, s.chooseTitle]}>Service complete</Text>
      <Text style={[fontMed, s.chooseSub]}>How would you like to pay?</Text>

      <View style={s.amountWrap}>
        <Text style={[fontExtra, s.amountBig]}>₹{amountRupees}</Text>
      </View>

      {/* PRIMARY — Pay online. Amber gradient via SVG overlay
          (same pattern as PrimaryButton + the cash banner on
          the pro app's State C2 — no new dep). */}
      <TouchableOpacity style={s.primaryBtn} onPress={onPayOnline} accessibilityRole="button">
        <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
          <Defs>
            <SvgLinearGradient id="eosPayPrimaryGrad" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor={AMBER_HI} />
              <Stop offset="50%" stopColor={AMBER} />
              <Stop offset="100%" stopColor={AMBER_LO} />
            </SvgLinearGradient>
          </Defs>
          <Rect width="100%" height="100%" rx="14" fill="url(#eosPayPrimaryGrad)" />
        </Svg>
        <View style={s.primaryBtnInner}>
          <Text style={[fontExtra, s.primaryBtnText]}>Pay online</Text>
          <Text style={[fontMed, s.primaryBtnSub]}>UPI · Cards · Net banking</Text>
        </View>
      </TouchableOpacity>

      {/* SECONDARY — Pay with cash instead. Quiet ghost. */}
      <TouchableOpacity style={s.ghostBtn} onPress={onPayCash} accessibilityRole="button">
        <Text style={[fontBold, s.ghostBtnText]}>Pay with cash instead</Text>
      </TouchableOpacity>

      <View style={s.reassureWrap}>
        <Feather name="shield" size={13} color="rgba(255,255,255,0.55)" />
        <Text style={[fontReg, s.reassureText]}>
          Pay securely — you're only charged now that the service is complete.
        </Text>
      </View>
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────
// STATE 2 — "Pay with cash?" confirmation popup
// REVERSED emphasis: "Pay online instead" = primary (pulls back),
// "Yes, pay cash" = quiet text button.
// ───────────────────────────────────────────────────────────────────

function CashConfirmPopup({
  amountRupees,
  proFirstName,
  onPayOnlineInstead,
  onYesPayCash,
  onDismiss,
}: {
  amountRupees: number;
  proFirstName: string;
  onPayOnlineInstead: () => void;
  onYesPayCash: () => void;
  onDismiss: () => void;
}) {
  return (
    <View style={s.popupBackdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View style={s.popupCard}>
        <Text style={[fontExtra, s.popupTitle]}>Pay with cash?</Text>
        <Text style={[fontMed, s.popupBody]}>
          You'll hand ₹{amountRupees} to {proFirstName} directly. Paying online is faster and gives you an instant receipt.
        </Text>

        {/* PRIMARY — "Pay online instead" pulls back to online. */}
        <TouchableOpacity
          style={s.popupPrimaryBtn}
          onPress={onPayOnlineInstead}
          accessibilityRole="button"
        >
          <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
            <Defs>
              <SvgLinearGradient id="eosPopupGrad" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0%" stopColor={AMBER_HI} />
                <Stop offset="50%" stopColor={AMBER} />
                <Stop offset="100%" stopColor={AMBER_LO} />
              </SvgLinearGradient>
            </Defs>
            <Rect width="100%" height="100%" rx="14" fill="url(#eosPopupGrad)" />
          </Svg>
          <Text style={[fontExtra, s.popupPrimaryBtnText]}>Pay online instead</Text>
        </TouchableOpacity>

        {/* QUIET — "Yes, pay cash" deliberately understated. */}
        <TouchableOpacity
          style={s.popupQuietBtn}
          onPress={onYesPayCash}
          accessibilityRole="button"
        >
          <Text style={[fontMed, s.popupQuietBtnText]}>Yes, pay cash</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────
// STATE 3 — Opening secure payment…
// Transitional spinner; the real Cashfree drop sheet opens on top of
// this in 5d.2. The sheet is Cashfree's own native UI — we don't
// build it. Cashfree's callback returns success/failure.
// ───────────────────────────────────────────────────────────────────

function OpeningState({ amountRupees }: { amountRupees: number }) {
  const rot = useSharedValue(0);
  React.useEffect(() => {
    rot.value = withRepeat(
      withTiming(360, { duration: 900, easing: Easing.linear }),
      -1,
      false,
    );
  }, [rot]);
  const spinnerStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rot.value}deg` }],
  }));

  return (
    <View style={s.openingWrap}>
      <Animated.View style={[s.openingSpinner, spinnerStyle]}>
        <View style={s.openingSpinnerInner} />
      </Animated.View>
      <Text style={[fontExtra, s.openingTitle]}>Opening secure payment…</Text>
      <Text style={[fontMed, s.openingSub]}>
        ₹{amountRupees} · Bathroom cleaning
      </Text>
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────
// STATE 5 — Payment didn't go through
// Calm failure. Try again (primary, retry online) +
// Pay with cash instead (secondary, NO popup — clean fallback).
// ───────────────────────────────────────────────────────────────────

function FailedState({
  amountRupees,
  onTryAgain,
  onCashInstead,
}: {
  amountRupees: number;
  onTryAgain: () => void;
  onCashInstead: () => void;
}) {
  return (
    <View style={s.failedWrap}>
      <View style={s.failedIcon}>
        <Feather name="alert-triangle" size={26} color={AMBER} />
      </View>
      <Text style={[fontExtra, s.failedTitle]}>Payment didn't go through</Text>
      <Text style={[fontMed, s.failedSub]}>
        Don't worry, ₹{amountRupees} hasn't been charged. Try again or pay with cash.
      </Text>

      <TouchableOpacity style={s.primaryBtn} onPress={onTryAgain} accessibilityRole="button">
        <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
          <Defs>
            <SvgLinearGradient id="eosFailRetryGrad" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor={AMBER_HI} />
              <Stop offset="50%" stopColor={AMBER} />
              <Stop offset="100%" stopColor={AMBER_LO} />
            </SvgLinearGradient>
          </Defs>
          <Rect width="100%" height="100%" rx="14" fill="url(#eosFailRetryGrad)" />
        </Svg>
        <View style={s.primaryBtnInner}>
          <Text style={[fontExtra, s.primaryBtnText]}>Try again</Text>
        </View>
      </TouchableOpacity>

      {/* Cash from State 5 is the CLEAN fallback — no popup. */}
      <TouchableOpacity style={s.ghostBtn} onPress={onCashInstead} accessibilityRole="button">
        <Text style={[fontBold, s.ghostBtnText]}>Pay with cash instead</Text>
      </TouchableOpacity>
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: INK },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  headerClose: { padding: 6 },
  headerSpacer: { flex: 1 },
  body: { padding: 20, gap: 22, paddingBottom: 40 },

  // STATE 1 — Choose
  chooseWrap: { gap: 14, alignItems: 'center' },
  completeIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  chooseTitle: { fontSize: 24, color: '#FFFFFF', letterSpacing: -0.4, marginTop: 6 },
  chooseSub: { fontSize: 14, color: 'rgba(255,255,255,0.65)' },
  amountWrap: { marginVertical: 12 },
  amountBig: { fontSize: 56, color: '#FFFFFF', letterSpacing: -1.5 },

  primaryBtn: {
    width: '100%',
    height: 60,
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 8,
  },
  primaryBtnInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  primaryBtnText: { fontSize: 17, color: INK, letterSpacing: -0.3 },
  primaryBtnSub: { fontSize: 11, color: 'rgba(13,13,15,0.7)' },

  ghostBtn: {
    width: '100%',
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  ghostBtnText: { fontSize: 14, color: 'rgba(255,255,255,0.75)' },

  reassureWrap: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    marginTop: 14,
  },
  reassureText: { flex: 1, fontSize: 12, lineHeight: 17, color: 'rgba(255,255,255,0.55)' },

  // STATE 2 popup
  popupBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  popupCard: {
    width: '100%',
    maxWidth: 360,
    padding: 22,
    borderRadius: 22,
    backgroundColor: '#15151A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 14,
  },
  popupTitle: { fontSize: 20, color: '#FFFFFF', letterSpacing: -0.3 },
  popupBody: { fontSize: 13, lineHeight: 19, color: 'rgba(255,255,255,0.65)' },
  popupPrimaryBtn: {
    width: '100%',
    height: 54,
    borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  popupPrimaryBtnText: { fontSize: 15, color: INK, letterSpacing: -0.2 },
  popupQuietBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
  popupQuietBtnText: { fontSize: 13, color: 'rgba(255,255,255,0.55)' },

  // STATE 3 opening
  openingWrap: { alignItems: 'center', gap: 16, paddingTop: 60 },
  openingSpinner: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 3,
    borderColor: 'rgba(245,163,0,0.18)',
    borderTopColor: AMBER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openingSpinnerInner: { width: 0, height: 0 },
  openingTitle: { fontSize: 20, color: '#FFFFFF', letterSpacing: -0.3, marginTop: 10 },
  openingSub: { fontSize: 13, color: 'rgba(255,255,255,0.55)' },

  // STATE 5 failed
  failedWrap: { alignItems: 'center', gap: 12, paddingTop: 30 },
  failedIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(245,163,0,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  failedTitle: { fontSize: 20, color: '#FFFFFF', letterSpacing: -0.3, marginTop: 4 },
  failedSub: {
    fontSize: 13,
    lineHeight: 19,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 4,
  },

  // 5d.1 dev toggles (removed before final 5d push)
  devToggleRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
    marginTop: 40,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  devToggleLabel: { fontSize: 11, color: 'rgba(255,255,255,0.4)' },
  devTogglePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  devTogglePillActive: { borderColor: AMBER, backgroundColor: 'rgba(245,163,0,0.12)' },
  devTogglePillText: { fontSize: 11, color: 'rgba(255,255,255,0.75)' },
});
