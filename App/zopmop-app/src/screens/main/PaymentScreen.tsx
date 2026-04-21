import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  NativeModules,
  NativeEventEmitter,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';

const MIN_TEST_AMOUNT_RUPEES = 1;

type RazorpayOptions = {
  key: string;
  amount: string;
  currency: 'INR';
  name: string;
  description?: string;
  prefill?: {
    name?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: {
    color?: string;
  };
};

type RazorpaySuccess = {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
};

type RazorpayFailure = {
  code?: number;
  description?: string;
};

type NativeRazorpayCheckout = {
  open: (options: RazorpayOptions) => void;
};

function openRazorpayNative(options: RazorpayOptions): Promise<RazorpaySuccess> {
  const native = NativeModules as {
    RNRazorpayCheckout?: NativeRazorpayCheckout;
    RazorpayEventEmitter?: object;
  };

  const checkoutModule = native.RNRazorpayCheckout;
  const eventSource = native.RazorpayEventEmitter ?? checkoutModule;

  if (!checkoutModule || typeof checkoutModule.open !== 'function' || !eventSource) {
    throw new Error(
      'Razorpay native module is missing in this build. Rebuild with expo run:ios/android and relaunch the Dev Client.',
    );
  }

  const emitter = new NativeEventEmitter(eventSource as any);

  return new Promise<RazorpaySuccess>((resolve, reject) => {
    const onSuccess = emitter.addListener('Razorpay::PAYMENT_SUCCESS', (data: RazorpaySuccess) => {
      onSuccess.remove();
      onError.remove();
      resolve(data);
    });

    const onError = emitter.addListener('Razorpay::PAYMENT_ERROR', (data: RazorpayFailure) => {
      onSuccess.remove();
      onError.remove();
      reject(data);
    });

    try {
      checkoutModule.open(options);
    } catch (error) {
      onSuccess.remove();
      onError.remove();
      reject(error);
    }
  });
}

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 4 },
    backBtn: { padding: 4, marginLeft: -4 },
    headerTitle: { fontFamily: FontFamily.bold, fontSize: FontSize['2xl'], color: c.text, letterSpacing: -0.5 },
    body: { flex: 1, paddingHorizontal: 16, gap: 12 },
    card: {
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      padding: 16,
      borderWidth: 1,
      borderColor: c.border,
      ...Shadow.sm,
      gap: 10,
    },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    subtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, lineHeight: 20 },
    label: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs, color: c.textMuted, letterSpacing: 0.4, textTransform: 'uppercase' },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: Radius.lg,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontFamily: FontFamily.medium,
      fontSize: FontSize.base,
      color: c.text,
    },
    payBtn: {
      marginTop: 2,
      backgroundColor: c.primary,
      borderRadius: Radius.lg,
      paddingVertical: 13,
      alignItems: 'center',
      justifyContent: 'center',
      ...Shadow.sm,
    },
    payBtnDisabled: { opacity: 0.65 },
    payBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: '#FFFFFF' },
    meta: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, lineHeight: 18 },
    okText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.success },
    errorText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.danger },
    line: { height: 1, backgroundColor: c.border, marginVertical: 2 },
  });
}

function getDigitsOnlyPhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return undefined;
  return digits.slice(-10);
}

export default function PaymentScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { user } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const [amountRupees, setAmountRupees] = useState('199');
  const [loading, setLoading] = useState(false);
  const [lastPaymentID, setLastPaymentID] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const razorpayKeyId = (process.env.EXPO_PUBLIC_RAZORPAY_KEY_ID ?? '').trim();
  const keyPreview = razorpayKeyId
    ? `${razorpayKeyId.slice(0, 9)}...${razorpayKeyId.slice(-4)}`
    : 'Not configured';

  const openCheckout = async () => {
    if (!razorpayKeyId) {
      Alert.alert(
        'Missing Razorpay key',
        'Set EXPO_PUBLIC_RAZORPAY_KEY_ID in zopmop-app/.env and restart the app.',
      );
      return;
    }

    const parsed = Number(amountRupees);
    if (!Number.isFinite(parsed) || parsed < MIN_TEST_AMOUNT_RUPEES) {
      Alert.alert('Invalid amount', `Enter at least ₹${MIN_TEST_AMOUNT_RUPEES}.`);
      return;
    }

    const amountPaise = Math.round(parsed * 100);
    setLoading(true);
    setLastError(null);

    try {
      const options: RazorpayOptions = {
        key: razorpayKeyId,
        amount: amountPaise.toString(),
        currency: 'INR',
        name: 'ZopMop',
        description: 'Payment gateway test',
        prefill: {
          name: user?.name,
          contact: getDigitsOnlyPhone(user?.phone),
        },
        notes: {
          test_mode: 'true',
          source: 'zopmop-payment-screen',
        },
        theme: {
          color: c.primary,
        },
      };

      const result = await openRazorpayNative(options);
      setLastPaymentID(result.razorpay_payment_id);
      Alert.alert('Payment success', `Payment ID: ${result.razorpay_payment_id}`);
    } catch (error: unknown) {
      const failure = error as RazorpayFailure;
      const message = failure.description?.trim() || (error as Error)?.message || 'Payment cancelled or failed.';
      setLastError(message);
      Alert.alert('Payment not completed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Payments (Test)</Text>
      </View>

      <View style={s.body}>
        <View style={s.card}>
          <Text style={s.title}>Razorpay Test Checkout</Text>
          <Text style={s.subtitle}>
            This screen uses your Razorpay test key for in-app checkout testing. Use a Development Build (not Expo Go).
          </Text>
          <View style={s.line} />
          <Text style={s.label}>Amount (INR)</Text>
          <TextInput
            style={s.input}
            value={amountRupees}
            onChangeText={setAmountRupees}
            keyboardType="decimal-pad"
            placeholder="Enter amount in rupees"
            placeholderTextColor={c.textMuted}
            editable={!loading}
          />
          <TouchableOpacity
            style={[s.payBtn, loading && s.payBtnDisabled]}
            activeOpacity={0.85}
            onPress={openCheckout}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={s.payBtnText}>Pay with Razorpay</Text>}
          </TouchableOpacity>
        </View>

        <View style={s.card}>
          <Text style={s.label}>Config</Text>
          <Text style={s.meta}>EXPO_PUBLIC_RAZORPAY_KEY_ID: {keyPreview}</Text>
          <Text style={s.meta}>Logged in as: {user?.phone ?? 'unknown user'}</Text>
          {lastPaymentID ? <Text style={s.okText}>Last payment success: {lastPaymentID}</Text> : null}
          {lastError ? <Text style={s.errorText}>Last failure: {lastError}</Text> : null}
        </View>
      </View>
    </SafeAreaView>
  );
}
