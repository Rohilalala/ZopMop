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

import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { useAuth } from '../../context/AuthContext';
import { resolveCash, ResolveCashError } from '../../api/bookings';
import {
  createCashfreeOrder,
  CashfreeOrderError,
  markCashfreeAttemptFailed,
} from '../../api/payments';
import {
  useCashfreePayment,
  PollAbortedError,
  PollTimeoutError,
} from '../../hooks/useCashfreePayment';
import { showError, showInfo, showSuccess } from '../../utils/toast';

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
  const { token } = useAuth();

  // Local UI state machine. 5d.2.b wires State 2; 5d.2.c wires 1+5.
  const [state, setState] = useState<LocalState>('choose');
  // State 5 sub-copy. Set when the SDK / poll path resolves with an
  // explicit message; falls back to a generic line when null.
  const [failureMessage, setFailureMessage] = useState<string | null>(null);

  // Phase 1 Step 5d.2.b — cash-confirm in-flight gate. submittingCash
  // drives the popup button's disabled + spinner UI; the ref guards
  // against rapid double-tap landing two POST /resolve-cash calls
  // before the first response. The backend's ResolveCash is idempotent
  // on repeat tap (Peek-then-Issue), so this is belt + braces, not
  // load-bearing for correctness — just keeps the UI honest.
  const [submittingCash, setSubmittingCash] = useState(false);
  const cashInFlight = useRef(false);

  // Phase 1 Step 5d.2.c — online-pay single-flight gate. Defends
  // against:
  //   1. Rapid double-tap on "Pay online" creating two Cashfree
  //      orders (the backend has findReusableCashfreeOrder protection
  //      but we also gate client-side so the UI never momentarily
  //      opens two Drop sheets).
  //   2. The user tapping "Pay online" on State 1, getting State 2
  //      popup, then tapping "Pay online instead" — both routes share
  //      the same gate so we can't double-fire.
  // Pairs with the useCashfreePayment hook's internal inFlightRef
  // which guards the SDK callback registration globally.
  const onlineInFlight = useRef(false);
  const pollAbortRef = useRef<AbortController | null>(null);

  // Cashfree hook — drop sheet + post-checkout poll. Hook's own
  // single-flight ref dedupes concurrent startPayment calls; ours
  // gates the surrounding flow (createCashfreeOrder + state
  // transitions) which the hook can't see.
  const { startPayment, pollStatus } = useCashfreePayment();

  // Abort any in-flight poll if the user dismisses the modal or the
  // screen unmounts — prevents a backgrounded poll from racing a
  // resumed state-1 flow with stale order ids.
  React.useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
    };
  }, []);

  const amountRupees = Math.round((amountPaise ?? 0) / 100);
  const proFirstName = (helperName ?? 'your pro').split(' ')[0];

  // Navigation handlers.
  const close = () => navigation.goBack();

  const tapPayCashInstead = () => setState('cash_confirm');

  // Phase 1 Step 5d.2.b — REAL cash resolve.
  //
  // Flow:
  //   1. Guard against re-entry (cashInFlight) + state-driven disable.
  //   2. POST /bookings/:id/resolve-cash → backend stamps
  //      cash_collected_at + issues End OTP via Peek-then-Issue.
  //   3. Success: close modal. TrackLive's useFocusEffect re-runs
  //      fetchDetail() on regaining focus → cash_collected_at lands
  //      in the local `detail` state → State 4a inline chip renders
  //      immediately. The End OTP card (EndCodeCard) appears once
  //      the next WS push delivers tracking.end_otp_code (push tick
  //      = ~5s — usually faster than the user can look down).
  //      NOTE: TrackingResponse does NOT carry cash_collected_at or
  //      payment_status; those live on the booking detail. The
  //      focus-effect refresh is what closes the gap.
  //   4. Error: branch on the typed wire code. Lock-rule outcomes
  //      below match the planning gate's error map; no retry loop
  //      yet — ONLINE_PAYMENT_PENDING just stays on State 1 with a
  //      "processing, please wait" hint until 5d.2.d wires the
  //      retry-with-mark-attempt-failed backstop.
  const tapYesPayCash = async () => {
    if (cashInFlight.current) return;
    if (!token) {
      showError('Please sign in again.');
      return;
    }
    cashInFlight.current = true;
    setSubmittingCash(true);
    try {
      await resolveCash(token, bookingId);
      showSuccess('Cash recorded — show the End OTP to your pro to wrap up.');
      close();
    } catch (e) {
      if (e instanceof ResolveCashError) {
        switch (e.code) {
          case 'ALREADY_PAID_ONLINE':
            // Online payment landed between modal-open and confirm.
            // TrackLive will render State 4b (paid online) inline.
            showInfo('Already paid online.');
            close();
            return;
          case 'JOB_NOT_IN_STATE':
            showError("This service isn't in progress anymore.");
            close();
            return;
          case 'NO_HELPER_ASSIGNED':
            showError('No pro is assigned to this booking.');
            close();
            return;
          case 'BOOKING_NOT_FOUND':
            showError('Booking not found.');
            close();
            return;
          case 'ONLINE_PAYMENT_PENDING':
            // 5d.2.d will replace this with a retry-with-cancel loop
            // that calls mark-attempt-failed on the stale Cashfree
            // order. For 5d.2.b: surface, back off, let the user
            // try again from State 1.
            showInfo('An online payment is processing — please wait a moment.');
            setState('choose');
            return;
          case 'OTP_SERVICE_UNAVAILABLE':
            showError('Service temporarily unavailable — please try again.');
            setState('choose');
            return;
          default:
            showError(e.message || 'Could not record cash payment.');
            setState('choose');
            return;
        }
      }
      showError('Could not record cash payment. Check your connection.');
      setState('choose');
    } finally {
      cashInFlight.current = false;
      setSubmittingCash(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  // Phase 1 Step 5d.2.c — REAL online payment via Cashfree Drop.
  //
  // Flow:
  //   1. Single-flight gate (onlineInFlight) prevents double-tap
  //      kicking off two orders. State transitions to 'opening' so
  //      the user sees the spinner while the backend mint is in
  //      flight.
  //   2. POST /payments/cashfree/order to mint a new (or reuse an
  //      existing pending) Cashfree session. Returns a
  //      payment_session_id + our merchant order_id.
  //   3. Hand the session to the SDK via useCashfreePayment.startPayment.
  //      The hook owns the SDK callback global; we receive on_success
  //      / on_failure via the opts we pass in.
  //   4. on_success: poll the backend status endpoint. The SDK fires
  //      onVerify BEFORE the gateway webhook lands on our server, so
  //      the SDK callback alone is not authoritative; the poll reads
  //      the canonical ledger after the webhook commits. On 'success'
  //      we close (TrackLive's useFocusEffect refreshes detail on
  //      regaining focus and inline State 4b chip renders).
  //   5. on_failure: call POST /payments/cashfree/orders/:orderID/
  //      mark-attempt-failed. The endpoint's conditional UPDATE is
  //      the atomic webhook-wins gate — if a real success webhook
  //      landed between the SDK on_failure callback and our request,
  //      the row already reads 'success' and the response tells us
  //      so. Branch:
  //        - gateway_status='success' → webhook won; payment is real;
  //          showSuccess + close, TrackLive flips to 4b on focus.
  //        - gateway_status='failed' → SDK callback wins; transition
  //          to State 5 with the SDK's error message.
  //        - other → treat as failed; defer to the user to retry or
  //          fall back to cash.
  //
  // SAFETY: the mark-attempt-failed call's trigger is the SDK's
  // on_failure callback specifically — never a timeout or heuristic.
  // A user backgrounding mid-payment doesn't fire on_failure, so a
  // slow-but-successful charge isn't raced into wrongly-cancelled
  // state.
  const startOnlinePayment = async (): Promise<void> => {
    if (onlineInFlight.current) return;
    if (!token) {
      showError('Please sign in again.');
      return;
    }
    onlineInFlight.current = true;
    setFailureMessage(null);
    setState('opening');

    // Step 2 — mint the Cashfree order. Backend handles ownership +
    // chargeability gating; map known 409s into actionable UI.
    let order;
    try {
      order = await createCashfreeOrder(token, {
        booking_id: bookingId,
        payment_source: 'direct',
      });
    } catch (e) {
      onlineInFlight.current = false;
      if (e instanceof CashfreeOrderError) {
        switch (e.code) {
          case 'already_paid_online':
          case 'already_paid':
            // Payment landed via another tab / webhook race window.
            showInfo('Already paid online.');
            close();
            return;
          case 'already_paid_cash':
            showInfo('Cash payment already recorded.');
            close();
            return;
          case 'booking_refunded':
            showError('This booking was refunded — contact support.');
            close();
            return;
          case 'booking_cancelled':
            showError("This booking isn't active anymore.");
            close();
            return;
          case 'gateway_unconfigured':
          case 'gateway_error':
            setFailureMessage("Payment gateway is having trouble. Try again or pay cash.");
            setState('failed');
            return;
          default:
            setFailureMessage(e.message);
            setState('failed');
            return;
        }
      }
      setFailureMessage("Couldn't start payment. Check your connection.");
      setState('failed');
      return;
    }

    // Step 3 — open Drop sheet. The hook's promise resolves once the
    // SDK fires either onVerify or onError; the actual branching
    // happens inside on_success / on_failure below.
    await startPayment({
      payment_session_id: order.payment_session_id,
      order_id: order.order_id,
      on_success: async () => {
        // Step 4 — wait for the webhook to flip gateway_status.
        const ctrl = new AbortController();
        pollAbortRef.current = ctrl;
        try {
          const snap = await pollStatus(order.order_id, { signal: ctrl.signal });
          onlineInFlight.current = false;
          if (snap.status === 'success') {
            showSuccess(`Paid ₹${amountRupees}.`);
            close();
            return;
          }
          if (snap.status === 'failed') {
            setFailureMessage('Payment failed. Try again or pay cash.');
            setState('failed');
            return;
          }
          // 'refunded' here is unusual — defer to a fresh start from
          // State 1.
          showError('Unexpected payment state — please try again.');
          setState('choose');
        } catch (pollErr) {
          onlineInFlight.current = false;
          if (pollErr instanceof PollAbortedError) {
            // Screen unmounted or user dismissed — do nothing.
            return;
          }
          if (pollErr instanceof PollTimeoutError) {
            // Webhook will land within a minute. Close + let the
            // customer see the canonical state on TrackLive.
            showInfo('Confirming payment — should land in a moment.');
            close();
            return;
          }
          setFailureMessage("Couldn't confirm payment. Check Bookings to see status.");
          setState('failed');
        }
      },
      on_failure: async (cfErr) => {
        // Step 5 — flag the order failed so the cash fallback (if the
        // user picks it from State 5) doesn't trip the residual-race
        // guard on /resolve-cash. The conditional UPDATE on the
        // backend is the webhook-wins atomic gate.
        const sdkMessage = cfErr.getMessage?.() || 'Payment didn\'t go through';
        try {
          const flagged = await markCashfreeAttemptFailed(token, order.order_id);
          onlineInFlight.current = false;
          if (flagged.gateway_status === 'success') {
            // Webhook beat the SDK callback. Money moved. Treat as paid.
            showSuccess(`Paid ₹${amountRupees}.`);
            close();
            return;
          }
          // 'failed' / 'refunded' / 'pending' (rare race) — show
          // State 5 so the user can retry or fall back to cash.
          setFailureMessage(sdkMessage);
          setState('failed');
        } catch {
          // mark-attempt-failed itself failed (network blip /
          // backend down). Still surface failure to the user; the
          // residual-race guard on resolveCash will trip on the cash
          // fallback only if the row stays pending past the 2-min
          // freshness window. Worst case: user waits.
          onlineInFlight.current = false;
          setFailureMessage(sdkMessage);
          setState('failed');
        }
      },
    });
  };

  const tapPayOnline = () => {
    void startOnlinePayment();
  };
  const tapPayOnlineInsteadFromPopup = () => {
    void startOnlinePayment();
  };
  const tapTryAgainFromFailure = () => {
    void startOnlinePayment();
  };

  // Phase 1 Step 5d.2.c — State 5 cash fallback. NO popup — online
  // already failed; cash is the legitimate path forward. Calls
  // resolveCash directly. The mark-attempt-failed call in the SDK
  // on_failure handler above already flipped the order to 'failed'
  // (assuming the webhook didn't win), so the residual-race guard
  // sees no pending Cashfree order on the booking and accepts the
  // cash fallback on the first attempt.
  const tapCashInsteadFromFailure = async () => {
    if (cashInFlight.current) return;
    if (!token) {
      showError('Please sign in again.');
      return;
    }
    cashInFlight.current = true;
    setSubmittingCash(true);
    try {
      await resolveCash(token, bookingId);
      showSuccess('Cash recorded — show the End OTP to your pro to wrap up.');
      close();
    } catch (e) {
      if (e instanceof ResolveCashError) {
        switch (e.code) {
          case 'ALREADY_PAID_ONLINE':
            showInfo('Already paid online.');
            close();
            return;
          case 'JOB_NOT_IN_STATE':
            showError("This service isn't in progress anymore.");
            close();
            return;
          case 'NO_HELPER_ASSIGNED':
            showError('No pro is assigned to this booking.');
            close();
            return;
          case 'BOOKING_NOT_FOUND':
            showError('Booking not found.');
            close();
            return;
          case 'ONLINE_PAYMENT_PENDING':
            // Rare race: mark-attempt-failed hadn't landed yet
            // when the customer tapped the cash fallback. Give the
            // residual-race window a moment, then try once more —
            // if it still bounces, defer to user.
            showInfo('Wrapping up the online attempt — try again in a moment.');
            return;
          case 'OTP_SERVICE_UNAVAILABLE':
            showError('Service temporarily unavailable — please try again.');
            return;
          default:
            showError(e.message || 'Could not record cash payment.');
            return;
        }
      }
      showError('Could not record cash payment. Check your connection.');
    } finally {
      cashInFlight.current = false;
      setSubmittingCash(false);
    }
  };

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
            subCopy={failureMessage}
            cashBusy={submittingCash}
            onTryAgain={tapTryAgainFromFailure}
            onCashInstead={tapCashInsteadFromFailure}
          />
        )}
      </ScrollView>

      {/* Cash confirmation popup overlays the choose state. Renders
          on top of whatever is below. */}
      {state === 'cash_confirm' && (
        <CashConfirmPopup
          amountRupees={amountRupees}
          proFirstName={proFirstName}
          onPayOnlineInstead={tapPayOnlineInsteadFromPopup}
          onYesPayCash={tapYesPayCash}
          onDismiss={() => {
            // While the resolve-cash POST is in flight, suppress the
            // backdrop-dismiss to avoid stranding the loading button
            // in a state the user can't see.
            if (submittingCash) return;
            setState('choose');
          }}
          submitting={submittingCash}
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
  submitting,
}: {
  amountRupees: number;
  proFirstName: string;
  onPayOnlineInstead: () => void;
  onYesPayCash: () => void;
  onDismiss: () => void;
  submitting: boolean;
}) {
  return (
    <View style={s.popupBackdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View style={s.popupCard}>
        <Text style={[fontExtra, s.popupTitle]}>Pay with cash?</Text>
        <Text style={[fontMed, s.popupBody]}>
          You'll hand ₹{amountRupees} to {proFirstName} directly. Paying online is faster and gives you an instant receipt.
        </Text>

        {/* PRIMARY — "Pay online instead" pulls back to online.
            Also disabled while a cash resolve is in flight so a
            mid-flight tap can't kick off the Cashfree drop sheet
            while the cash POST is still landing. */}
        <TouchableOpacity
          style={[s.popupPrimaryBtn, submitting && s.popupBtnDisabled]}
          onPress={onPayOnlineInstead}
          accessibilityRole="button"
          disabled={submitting}
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

        {/* QUIET — "Yes, pay cash" deliberately understated.
            Disabled + spinner while the POST is in flight. */}
        <TouchableOpacity
          style={s.popupQuietBtn}
          onPress={onYesPayCash}
          accessibilityRole="button"
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator size="small" color="rgba(255,255,255,0.55)" />
          ) : (
            <Text style={[fontMed, s.popupQuietBtnText]}>Yes, pay cash</Text>
          )}
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
  subCopy,
  cashBusy,
  onTryAgain,
  onCashInstead,
}: {
  amountRupees: number;
  // Optional SDK error message. When null, defaults to the calm
  // "Don't worry, ₹X hasn't been charged" line — works for the
  // generic-failure case and the createCashfreeOrder gateway-error
  // case alike.
  subCopy: string | null;
  // Spinner-in-button while the cash-fallback POST is in flight.
  cashBusy: boolean;
  onTryAgain: () => void;
  onCashInstead: () => void;
}) {
  const subLine =
    subCopy && subCopy.trim().length > 0
      ? subCopy
      : `Don't worry, ₹${amountRupees} hasn't been charged. Try again or pay with cash.`;
  return (
    <View style={s.failedWrap}>
      <View style={s.failedIcon}>
        <Feather name="alert-triangle" size={26} color={AMBER} />
      </View>
      <Text style={[fontExtra, s.failedTitle]}>Payment didn't go through</Text>
      <Text style={[fontMed, s.failedSub]}>{subLine}</Text>

      <TouchableOpacity
        style={[s.primaryBtn, cashBusy && { opacity: 0.55 }]}
        onPress={onTryAgain}
        accessibilityRole="button"
        disabled={cashBusy}
      >
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
      <TouchableOpacity
        style={s.ghostBtn}
        onPress={onCashInstead}
        accessibilityRole="button"
        disabled={cashBusy}
      >
        {cashBusy ? (
          <ActivityIndicator size="small" color="rgba(255,255,255,0.75)" />
        ) : (
          <Text style={[fontBold, s.ghostBtnText]}>Pay with cash instead</Text>
        )}
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
  popupQuietBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    minHeight: 38,
  },
  popupQuietBtnText: { fontSize: 13, color: 'rgba(255,255,255,0.55)' },
  popupBtnDisabled: { opacity: 0.55 },

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
});
