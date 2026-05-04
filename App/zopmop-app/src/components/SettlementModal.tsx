import React, { useState } from 'react';
import {
  
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LoadingBars } from './ui/LoadingBars';
import { useRoomies } from '../context/RoomiesContext';
import { useColors } from '../context/ThemeContext';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../theme';
import { lightColors } from '../theme/colors';

type C = typeof lightColors;

const MIN_TOPUP = 25000; // ₹250 — must match backend constant

function createStyles(c: C) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.white,
      borderTopLeftRadius: Radius['2xl'],
      borderTopRightRadius: Radius['2xl'],
      padding: Spacing.base,
      paddingBottom: Spacing['2xl'],
      ...Shadow.lg,
    },
    handle: {
      width: 40,
      height: 4,
      backgroundColor: c.border,
      borderRadius: Radius.full,
      alignSelf: 'center',
      marginBottom: Spacing.md,
    },
    title: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.xl,
      color: c.text,
      marginBottom: 4,
    },
    subtitle: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      marginBottom: Spacing.base,
    },
    amountHighlight: {
      fontFamily: FontFamily.bold,
      color: c.primary,
    },
    divider: { height: 1, backgroundColor: c.border, marginVertical: Spacing.md },
    sectionTitle: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.textMuted,
      marginBottom: Spacing.sm,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      marginBottom: Spacing.sm,
      backgroundColor: c.surface,
    },
    inputPrefix: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.textSecondary,
      marginRight: 4,
    },
    input: {
      flex: 1,
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.text,
      paddingVertical: Spacing.sm,
    },
    inputError: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.danger,
      marginBottom: Spacing.sm,
    },
    btn: {
      borderRadius: Radius.lg,
      paddingVertical: Spacing.md,
      alignItems: 'center',
      marginBottom: Spacing.sm,
    },
    btnPrimary: { backgroundColor: c.primary },
    btnSecondary: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: c.border,
    },
    btnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: '#FFFFFF',
    },
    btnTextSecondary: { color: c.text },
    successText: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      textAlign: 'center',
      marginTop: Spacing.sm,
    },
  });
}

interface Props {
  visible: boolean;
  debtID: string;
  debtorUserID: string; // the member ID for top-up
  groupID: string;
  amountOwed: number; // in units (paise)
  onClose: () => void;
}

/**
 * Settlement modal with two paths:
 * 1. Top Up Prepaid Wallet → enforces ₹250 minimum client-side before hitting endpoint.
 * 2. Settle Externally → marks debt pending_verification, waits for creditor to verify.
 */
export default function SettlementModal({
  visible,
  debtID,
  debtorUserID,
  groupID,
  amountOwed,
  onClose,
}: Props) {
  const { topUpPrepaid, settleExternal } = useRoomies();
  const c = useColors();
  const s = React.useMemo(() => createStyles(c), [c]);

  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpError, setTopUpError] = useState('');
  const [externalDone, setExternalDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleTopUp = async () => {
    const amount = Math.round(parseFloat(topUpAmount) * 100); // user enters ₹, convert to units
    if (isNaN(amount) || amount < MIN_TOPUP) {
      setTopUpError('Minimum top-up is ₹250');
      return;
    }
    setTopUpError('');
    setLoading(true);
    try {
      await topUpPrepaid(debtorUserID, groupID, amount);
      onClose();
    } catch (e: any) {
      setTopUpError(e.message ?? 'Top-up failed');
    } finally {
      setLoading(false);
    }
  };

  const handleExternal = async () => {
    setLoading(true);
    try {
      await settleExternal(debtID);
      setExternalDone(true);
    } catch (e: any) {
      setTopUpError(e.message ?? 'Failed to mark as settled');
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setTopUpAmount('');
    setTopUpError('');
    setExternalDone(false);
    setLoading(false);
    onClose();
  };

  const amountDisplay = `₹${(amountOwed / 100).toFixed(0)}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={reset}>
      <KeyboardAvoidingView
        style={s.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={{ flex: 1 }} onPress={reset} />
        <View style={s.sheet} onStartShouldSetResponder={() => true}>
          <View style={s.handle} />
          <Text style={s.title}>Settle Debt</Text>
          <Text style={s.subtitle}>
            You owe <Text style={s.amountHighlight}>{amountDisplay}</Text> to your roommate.
          </Text>

          {externalDone ? (
            <>
              <Text style={s.successText}>
                Marked as settled. Waiting for your roommate to verify.
              </Text>
              <Pressable style={[s.btn, s.btnPrimary, { marginTop: Spacing.md }]} onPress={reset}>
                <Text style={s.btnText}>Done</Text>
              </Pressable>
            </>
          ) : (
            <>
              {/* Option 1: Top Up Prepaid */}
              <Text style={s.sectionTitle}>Top Up Prepaid Wallet</Text>
              <View style={s.inputRow}>
                <Text style={s.inputPrefix}>₹</Text>
                <TextInput
                  style={s.input}
                  placeholder="Enter amount (min ₹250)"
                  placeholderTextColor={c.textMuted}
                  keyboardType="numeric"
                  value={topUpAmount}
                  onChangeText={v => {
                    setTopUpAmount(v);
                    setTopUpError('');
                  }}
                />
              </View>
              {topUpError ? <Text style={s.inputError}>{topUpError}</Text> : null}
              <Pressable
                style={[s.btn, s.btnPrimary, loading && { opacity: 0.6 }]}
                onPress={handleTopUp}
                disabled={loading}
              >
                {loading ? (
                  <LoadingBars color="#FFF" />
                ) : (
                  <Text style={s.btnText}>Add to Wallet</Text>
                )}
              </Pressable>

              <View style={s.divider} />

              {/* Option 2: Settle Externally */}
              <Text style={s.sectionTitle}>Already Paid in Cash?</Text>
              <Pressable
                style={[s.btn, s.btnSecondary, loading && { opacity: 0.6 }]}
                onPress={handleExternal}
                disabled={loading}
              >
                <Text style={s.btnTextSecondary}>Mark as Settled Externally</Text>
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
