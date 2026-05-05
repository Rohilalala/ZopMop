// WalletTopupSheet — Cashfree-funded topup of the closed-loop wallet.
//
// Encapsulates: amount input + validation → POST /wallet/topup → Cashfree
// Drop Checkout SDK → /payments/cashfree/orders/:orderID/status poll →
// final UX outcome (success toast / processing toast / inline failure).
//
// The hook (useCashfreePayment) owns SDK callback wiring; this component
// owns the user-facing copy + sheet lifecycle. Parent re-fetches balance +
// transactions only after the sheet calls onSuccess.

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '../../components/ui/BottomSheet';
import { PressFx } from '../../components/ui/PressFx';
import { topupWallet } from '../../api/wallet';
import { useCashfreePayment, PollTimeoutError } from '../../hooks/useCashfreePayment';
import { showError, showSuccess, showInfo } from '../../utils/toast';
import { haptics } from '../../utils/haptics';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const MIN_RUPEES = 1;
const MAX_RUPEES = 5000;

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  token: string;
};

type UiState = 'idle' | 'creating_order' | 'sdk_open' | 'polling';

export default function WalletTopupSheet({ visible, onClose, onSuccess, token }: Props) {
  const { startPayment, pollStatus } = useCashfreePayment();

  // Raw text driven by the input. Stripped to digits on every keystroke so
  // the parsed amount always reflects what the user sees.
  const [amountText, setAmountText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<UiState>('idle');

  const parsedRupees = useMemo(() => {
    const cleaned = amountText.replace(/\D+/g, '');
    if (!cleaned) return null;
    const n = Number.parseInt(cleaned, 10);
    return Number.isFinite(n) ? n : null;
  }, [amountText]);

  const isValid =
    parsedRupees !== null && parsedRupees >= MIN_RUPEES && parsedRupees <= MAX_RUPEES;

  const ctaDisabled = !isValid || state !== 'idle';

  const onChangeAmount = useCallback((next: string) => {
    setAmountText(next.replace(/\D+/g, ''));
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setAmountText('');
    setError(null);
    setState('idle');
  }, []);

  const close = useCallback(() => {
    if (state === 'sdk_open' || state === 'polling') {
      // Don't let the user dismiss while the SDK sheet is open or we're
      // polling — would risk leaking callbacks. The BottomSheet's pan
      // and backdrop are still usable in idle/error states.
      return;
    }
    reset();
    onClose();
  }, [state, reset, onClose]);

  const handleConfirm = useCallback(async () => {
    if (!isValid || parsedRupees === null) return;
    haptics.medium();
    Keyboard.dismiss();

    const amountPaise = parsedRupees * 100;
    setState('creating_order');
    setError(null);

    let topup;
    try {
      topup = await topupWallet(token, amountPaise);
    } catch (err) {
      setState('idle');
      const code = (err as { code?: string }).code;
      if (code === 'amount_too_low') {
        setError(`Minimum ₹${MIN_RUPEES}`);
      } else if (code === 'amount_too_high') {
        setError(`Maximum ₹${MAX_RUPEES.toLocaleString('en-IN')}`);
      } else {
        setError("Couldn't start payment. Try again.");
      }
      return;
    }

    setState('sdk_open');
    await startPayment({
      payment_session_id: topup.payment_session_id,
      order_id: topup.order_id,
      on_success: async () => {
        // SDK reached terminal-success state; backend webhook may or may
        // not have landed yet. Poll for the canonical status.
        setState('polling');
        try {
          const snap = await pollStatus(topup.order_id);
          reset();
          onClose();
          if (snap.status === 'success') {
            showSuccess(`Wallet topped up: ₹${parsedRupees.toLocaleString('en-IN')}`, {
              title: 'Added to wallet',
            });
            onSuccess();
          } else {
            showError(
              snap.status === 'refunded'
                ? 'Payment was refunded.'
                : 'Payment failed.',
              { title: 'Topup failed' },
            );
          }
        } catch (pollErr) {
          reset();
          onClose();
          if (pollErr instanceof PollTimeoutError) {
            showInfo("Payment processing — check back in a minute.", {
              title: 'Topup pending',
            });
            // Refetch anyway — webhook may land between now and the
            // user's next visit and we want fresh state on screen.
            onSuccess();
          } else {
            showError("Couldn't confirm payment. Pull to refresh shortly.", {
              title: 'Topup status unknown',
            });
            onSuccess();
          }
        }
      },
      on_failure: (cfErr) => {
        // SDK said failure. Keep sheet open so user can adjust + retry.
        setState('idle');
        const message = cfErr.getMessage?.() || 'Payment failed';
        setError(message);
      },
    });
  }, [isValid, parsedRupees, token, startPayment, pollStatus, reset, onClose, onSuccess]);

  const ctaLabel = useMemo(() => {
    if (state === 'creating_order') return 'Starting payment…';
    if (state === 'sdk_open' || state === 'polling') return 'Processing…';
    if (parsedRupees === null) return 'Enter amount';
    return `Add ₹${parsedRupees.toLocaleString('en-IN')}`;
  }, [parsedRupees, state]);

  return (
    <BottomSheet visible={visible} onClose={close} height={420}>
      <View style={s.sheet}>
        <View style={s.header}>
          <View style={s.iconWrap}>
            <Feather name="plus-circle" size={20} color="#F5A300" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Add money to wallet</Text>
            <Text style={s.subtitle}>Funds stay in your Zopmop wallet.</Text>
          </View>
        </View>

        <View style={s.inputBlock}>
          <Text style={s.inputLabel}>Amount</Text>
          <View style={s.inputRow}>
            <Text style={s.inputCurrency}>₹</Text>
            <TextInput
              accessibilityLabel="Topup amount in rupees"
              style={s.input}
              value={amountText}
              onChangeText={onChangeAmount}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor="rgba(255,255,255,0.3)"
              maxLength={6}
              editable={state === 'idle'}
              returnKeyType="done"
              onSubmitEditing={handleConfirm}
            />
          </View>
          {error ? (
            <Text style={s.errorText}>{error}</Text>
          ) : (
            <Text style={s.helperText}>Min ₹{MIN_RUPEES} · Max ₹{MAX_RUPEES.toLocaleString('en-IN')}</Text>
          )}
        </View>

        <PressFx
          accessibilityRole="button"
          onPress={handleConfirm}
          disabled={ctaDisabled}
          style={[s.cta, ctaDisabled && s.ctaDisabled]}
        >
          {state !== 'idle' ? (
            <ActivityIndicator size="small" color="#0D0D0F" />
          ) : (
            <Text style={s.ctaText}>{ctaLabel}</Text>
          )}
        </PressFx>

        <Text style={s.legal}>
          You'll be redirected to Cashfree's secure payment sheet. Returns automatically after payment.
        </Text>
      </View>
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  sheet: {
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 28,
    gap: 18,
    backgroundColor: '#101012',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    flex: 1,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.14)',
  },
  title: { ...fontExtra, fontSize: 18, color: '#FFFFFF', letterSpacing: -0.3 },
  subtitle: { ...fontMed, fontSize: 12.5, color: 'rgba(255,255,255,0.55)', marginTop: 2 },

  inputBlock: { gap: 8 },
  inputLabel: {
    ...fontSemi,
    fontSize: 11,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.45)',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  inputCurrency: {
    ...fontSemi,
    fontSize: 22,
    color: 'rgba(255,255,255,0.65)',
  },
  input: {
    ...fontExtra,
    flex: 1,
    fontSize: 28,
    color: '#FFFFFF',
    padding: 0,
    letterSpacing: -0.6,
  },
  errorText: {
    ...fontSemi,
    fontSize: 12,
    color: '#FF8E8E',
    marginTop: 2,
  },
  helperText: {
    ...fontMed,
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 2,
  },

  cta: {
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F5A300',
  },
  ctaDisabled: { backgroundColor: 'rgba(245,163,0,0.35)' },
  ctaText: {
    ...fontExtra,
    fontSize: 15,
    color: '#0D0D0F',
    letterSpacing: -0.2,
  },

  legal: {
    ...fontMed,
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    lineHeight: 15,
    textAlign: 'center',
  },
});
