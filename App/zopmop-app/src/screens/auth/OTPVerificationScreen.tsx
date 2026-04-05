import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Clipboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { getIdToken } from '@react-native-firebase/auth';
import { otpStore } from '../../utils/otpStore';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'OTPVerification'>;
  route: RouteProp<AuthStackParamList, 'OTPVerification'>;
};

const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;

export default function OTPVerificationScreen({ navigation, route }: Props) {
  const { phone } = route.params;
  const confirmation = otpStore.get();

  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(RESEND_SECONDS);
  const [resending, setResending] = useState(false);

  const inputRefs = useRef<Array<TextInput | null>>(Array(OTP_LENGTH).fill(null));

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // Auto-verify when all 6 digits are filled
  useEffect(() => {
    const code = otp.join('');
    if (code.length === OTP_LENGTH && !loading) {
      handleVerify(code);
    }
  }, [otp]);

  async function handleVerify(code?: string) {
    const fullCode = code ?? otp.join('');
    if (fullCode.length < OTP_LENGTH) return;
    setError('');
    setLoading(true);

    try {
      if (!confirmation) throw new Error('Session expired. Please go back and try again.');
      const userCredential = await confirmation.confirm(fullCode);
      // Exchange Firebase ID token for backend JWT (best-effort; falls back if backend unavailable).
      let backendToken: string | undefined;
      let backendUser: any | undefined;
      try {
        const idToken = userCredential?.user ? await getIdToken(userCredential.user) : undefined;
        const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';
        const res = await fetch(`${BASE_URL}/auth/firebase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firebase_token: idToken }),
        });
        if (res.ok) {
          const data = await res.json();
          backendToken = data.token as string;
          backendUser = data.user;
        }
      } catch {
        // Backend unavailable — token will be undefined, address saving is deferred.
      }
      // Skip name screen for returning users who already have a name.
      const hasName = backendUser?.name && backendUser.name.trim().length > 0;
      if (hasName) {
        navigation.replace('RoleSelection', { phone, backendToken, backendUser });
      } else {
        navigation.replace('NameEntry', { phone, backendToken, backendUser });
      }
    } catch (err: any) {
      const msg =
        err?.code === 'auth/invalid-verification-code'
          ? 'Incorrect code. Please try again.'
          : err?.code === 'auth/code-expired'
            ? 'Code expired. Please request a new one.'
            : `Error: ${err?.code ?? err?.message ?? String(err)}`;
      setError(msg);
      // Clear OTP boxes on error
      setOtp(Array(OTP_LENGTH).fill(''));
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } finally {
      setLoading(false);
    }
  }

  async function exchangeForBackendJWT(firebaseToken: string) {
    const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';
    const res = await fetch(`${BASE_URL}/auth/firebase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firebase_token: firebaseToken }),
    });

    if (!res.ok) throw new Error('Backend auth failed');

    const data = await res.json();
    // TODO: store data.token in SecureStore and set user in Zustand
    // For now, navigate to main app (placeholder)
    navigation.reset({ index: 0, routes: [{ name: 'PhoneEntry' }] });
  }

  async function handleResend() {
    setResending(true);
    setError('');
    try {
      const { getAuth, signInWithPhoneNumber } = await import('@react-native-firebase/auth');
      const newConfirmation = await signInWithPhoneNumber(getAuth(), phone);
      otpStore.set(newConfirmation);
      setCountdown(RESEND_SECONDS);
      setOtp(Array(OTP_LENGTH).fill(''));
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } catch {
      setError('Failed to resend OTP. Please try again.');
    } finally {
      setResending(false);
    }
  }

  function handleKeyPress(index: number, key: string) {
    if (key === 'Backspace') {
      if (otp[index]) {
        // Clear current box
        const next = [...otp];
        next[index] = '';
        setOtp(next);
      } else if (index > 0) {
        // Move to previous box
        const next = [...otp];
        next[index - 1] = '';
        setOtp(next);
        inputRefs.current[index - 1]?.focus();
      }
    }
  }

  function handleDigitChange(index: number, text: string) {
    // Support pasting full 6-digit code
    const pasted = text.replace(/\D/g, '');
    if (pasted.length === OTP_LENGTH) {
      const chars = pasted.split('');
      setOtp(chars);
      inputRefs.current[OTP_LENGTH - 1]?.focus();
      return;
    }

    const digit = pasted.slice(-1);
    if (!digit) return;

    const next = [...otp];
    next[index] = digit;
    setOtp(next);

    if (index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  const maskedPhone = phone.replace(/(\+\d{2})(\d{5})(\d{5})/, '$1 $2 $3');

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.container}>


          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Verify your number</Text>
            <Text style={styles.subtitle}>
              Enter the 6-digit code sent to{'\n'}
              <Text style={styles.phoneHighlight}>{maskedPhone}</Text>
            </Text>
          </View>

          {/* OTP Boxes */}
          <View style={styles.otpRow}>
            {Array(OTP_LENGTH)
              .fill(null)
              .map((_, i) => (
                <TextInput
                  key={i}
                  ref={(r) => { inputRefs.current[i] = r; }}
                  style={[
                    styles.otpBox,
                    otp[i] ? styles.otpBoxFilled : null,
                    error ? styles.otpBoxError : null,
                  ]}
                  value={otp[i]}
                  onChangeText={(t) => handleDigitChange(i, t)}
                  onKeyPress={({ nativeEvent }) => handleKeyPress(i, nativeEvent.key)}
                  keyboardType="number-pad"
                  maxLength={OTP_LENGTH} // allow full paste
                  selectTextOnFocus
                  caretHidden
                  autoFocus={i === 0}
                />
              ))}
          </View>

          {/* Error */}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Resend */}
          <View style={styles.resendRow}>
            {countdown > 0 ? (
              <Text style={styles.resendCountdown}>
                Resend code in{' '}
                <Text style={styles.resendCountdownNum}>0:{String(countdown).padStart(2, '0')}</Text>
              </Text>
            ) : (
              <TouchableOpacity onPress={handleResend} disabled={resending}>
                {resending ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Text style={styles.resendLink}>Resend OTP</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Verify CTA */}
        <View style={styles.bottom}>
          <TouchableOpacity
            style={[
              styles.verifyButton,
              (otp.join('').length < OTP_LENGTH || loading) && styles.verifyButtonDisabled,
            ]}
            onPress={() => handleVerify()}
            disabled={otp.join('').length < OTP_LENGTH || loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color={Colors.white} size="small" />
            ) : (
              <Text style={styles.verifyButtonText}>Verify & Continue</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.changeNumber}
          >
            <Text style={styles.changeNumberText}>Change number</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const BOX_SIZE = 52;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  container: {
    flex: 1,
    paddingHorizontal: Spacing['2xl'],
    paddingTop: Spacing['2xl'],
  },

  backButton: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginBottom: Spacing.xl,
  },
  backArrow: {
    width: 9,
    height: 9,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: Colors.text,
    transform: [{ rotate: '45deg' }],
    marginLeft: 3,
    marginBottom: 1,
  },

  header: { marginBottom: Spacing['3xl'], gap: Spacing.md },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize['3xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    lineHeight: FontSize.base * 1.6,
  },
  phoneHighlight: {
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },

  // OTP boxes
  otpRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    justifyContent: 'space-between',
  },
  otpBox: {
    width: BOX_SIZE,
    height: BOX_SIZE + 8,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    textAlign: 'center',
    fontFamily: FontFamily.bold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    ...Shadow.sm,
  },
  otpBoxFilled: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryBg,
  },
  otpBoxError: {
    borderColor: Colors.danger,
    backgroundColor: Colors.dangerBg,
  },

  errorText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.danger,
    textAlign: 'center',
    marginTop: Spacing.md,
  },

  resendRow: {
    alignItems: 'center',
    marginTop: Spacing.xl,
  },
  resendCountdown: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  resendCountdownNum: {
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  resendLink: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.primary,
    textDecorationLine: 'underline',
  },

  // Bottom
  bottom: {
    paddingHorizontal: Spacing['2xl'],
    paddingBottom: Spacing['2xl'],
    gap: Spacing.md,
    alignItems: 'center',
  },
  verifyButton: {
    width: '100%',
    height: 54,
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.md,
  },
  verifyButtonDisabled: { opacity: 0.45 },
  verifyButtonText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.white,
    letterSpacing: 0.2,
  },
  changeNumber: { paddingVertical: Spacing.xs },
  changeNumberText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
});
