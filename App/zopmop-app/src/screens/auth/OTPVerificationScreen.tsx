import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  
  KeyboardAvoidingView,
  Platform,
  Linking,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { haptics } from '../../utils/haptics';
import LottieView from 'lottie-react-native';
import Feather from '@expo/vector-icons/Feather';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { posthog } from '../../config/posthog';
import { sendOTP, verifyOTP, AuthError } from '../../services/auth';

// Public-facing policy URLs. Kept inline rather than from env because they're
// the same across builds — the Privacy Policy link in the new-user consent
// must always point at the published policy regardless of API host.
const PRIVACY_POLICY_URL = 'https://zopmop.com/privacy';
const TERMS_URL = 'https://zopmop.com/terms';
const PRIVACY_ACCEPTED_KEY = 'auth.has_accepted_privacy_policy';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'OTPVerification'>;
  route: RouteProp<AuthStackParamList, 'OTPVerification'>;
};

// MSG91 templates default to 6-digit OTPs; dev mode hardcodes
// "999999" so testers can complete the flow without an SMS gateway.
const OTP_LENGTH = 6;
const RESEND_SECONDS = 30;

export default function OTPVerificationScreen({ navigation, route }: Props) {
  const { phone, isNewUser = false } = route.params;
  const { signIn } = useAuth();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(RESEND_SECONDS);
  const [resending, setResending] = useState(false);
  // Only enforced when isNewUser — returning users skip the checkbox entirely.
  const [policyAccepted, setPolicyAccepted] = useState(false);

  const inputRefs = useRef<Array<TextInput | null>>(Array(OTP_LENGTH).fill(null));
  const lookAwayRef = useRef<LottieView>(null);
  const lookAwayTriggered = useRef(false);

  function triggerLookAway() {
    if (lookAwayTriggered.current) return;
    lookAwayTriggered.current = true;
    lookAwayRef.current?.play();
  }

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // Auto-verify when all 6 digits are filled. For new users, also wait until
  // they tick the privacy-policy checkbox — otherwise we'd verify before
  // capturing consent.
  useEffect(() => {
    const code = otp.join('');
    if (code.length === OTP_LENGTH && !loading && (!isNewUser || policyAccepted)) {
      haptics.medium();
      handleVerify(code);
    }
  }, [otp, policyAccepted, loading, isNewUser]);

  async function handleVerify(code?: string) {
    const fullCode = code ?? otp.join('');
    if (fullCode.length < OTP_LENGTH) return;
    setError('');
    setLoading(true);

    try {
      const data = await verifyOTP(phone, fullCode, isNewUser ? policyAccepted : false);

      if (isNewUser && policyAccepted) {
        AsyncStorage.setItem(PRIVACY_ACCEPTED_KEY, 'true').catch(() => {});
      }

      haptics.success();
      posthog.capture('otp_verified', {
        is_new_user: data.is_new_user,
        user_type: data.user.type,
        role: data.user.role,
      });

      // Single-app: branch nav on user.type. Pros land on ProDashboard
      // via MainNavigator's initialRouteName which already reads
      // user.role. signIn populates that.
      if (data.user.role === 'helper' || data.user.role === 'pro' || data.user.type === 'pro') {
        signIn(data.access_token, data.refresh_token, data.user);
        return;
      }

      // Customer flow: returning users with a name skip NameEntry.
      const hasName = data.user.name && data.user.name.trim().length > 0;
      if (hasName) {
        signIn(data.access_token, data.refresh_token, data.user);
        navigation.replace('Welcome', { phone, name: data.user.name });
      } else if (data.is_new_user) {
        // Stash tokens via signIn THEN route to NameEntry so the
        // user is authenticated for the profile-setup PUT /me call.
        signIn(data.access_token, data.refresh_token, data.user);
        navigation.replace('NameEntry', { phone });
      } else {
        signIn(data.access_token, data.refresh_token, data.user);
      }
    } catch (err: any) {
      haptics.error();
      if (err instanceof AuthError) {
        if (err.code === 'INVALID_OTP') {
          setError('Incorrect code. Please try again.');
        } else if (err.code === 'OTP_EXPIRED') {
          setError('Code expired. Please request a new one.');
        } else if (err.code === 'OTP_RATE_LIMITED') {
          const mins = err.retryAfter ? Math.ceil(err.retryAfter / 60) : 0;
          setError(mins > 0
            ? `Too many attempts. Please try again in ${mins} minute${mins > 1 ? 's' : ''}.`
            : 'Too many attempts. Please try again later.');
        } else if (err.status === 403) {
          setError(err.message || 'Account suspended. Contact support.');
        } else {
          setError(err.message || 'Verification failed. Please try again.');
        }
      } else {
        setError('Network error. Please try again.');
      }
      setOtp(Array(OTP_LENGTH).fill(''));
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setResending(true);
    setError('');
    try {
      await sendOTP(phone);
      setCountdown(RESEND_SECONDS);
      setOtp(Array(OTP_LENGTH).fill(''));
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } catch (err: any) {
      if (err instanceof AuthError && err.code === 'OTP_RATE_LIMITED') {
        const mins = err.retryAfter ? Math.ceil(err.retryAfter / 60) : 0;
        setError(mins > 0
          ? `Too many resends. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`
          : 'Too many resends. Try again later.');
      } else {
        setError('Failed to resend OTP. Please try again.');
      }
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
    // Support pasting the full OTP in one shot.
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
        {/* Lookaway mascot lottie — plays once on first OTP focus, sticks at end frame */}
        <View style={stylesLottie.wrap} pointerEvents="none">
          <LottieView
            ref={lookAwayRef}
            source={require('../../../assets/animation/lookaway.json')}
            autoPlay={false}
            loop={false}
            resizeMode="cover"
            style={stylesLottie.lottie}
          />
        </View>
        <View style={styles.container}>

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Verify your number</Text>
            <Text style={styles.subtitle}>
              Enter the {OTP_LENGTH}-digit code sent to{'\n'}
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
                  onFocus={triggerLookAway}
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                />
              ))}
          </View>

          {/* Error */}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Privacy / Terms consent — only for new users. Returning users
              already accepted on first sign-up. */}
          {isNewUser ? (
            <TouchableOpacity
              style={styles.consentRow}
              onPress={() => { haptics.light(); setPolicyAccepted((v) => !v); }}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, policyAccepted && styles.checkboxChecked]}>
                {policyAccepted ? (
                  <Feather name="check" size={14} color="#FFFFFF" />
                ) : null}
              </View>
              <Text style={styles.consentText}>
                I agree to the{' '}
                <Text
                  style={styles.consentLink}
                  onPress={() => Linking.openURL(TERMS_URL)}
                >
                  Terms of Service
                </Text>
                {' '}and{' '}
                <Text
                  style={styles.consentLink}
                  onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}
                >
                  Privacy Policy
                </Text>
              </Text>
            </TouchableOpacity>
          ) : null}

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
                  <LoadingBars size="small" color={c.primary} />
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
              (otp.join('').length < OTP_LENGTH || loading || (isNewUser && !policyAccepted)) && styles.verifyButtonDisabled,
            ]}
            onPress={() => handleVerify()}
            disabled={otp.join('').length < OTP_LENGTH || loading || (isNewUser && !policyAccepted)}
            activeOpacity={0.85}
          >
            {loading ? (
              <LoadingBars color="#FFFFFF" size="small" />
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

const stylesLottie = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject },
  lottie: { flex: 1, width: '100%', height: '100%' },
});

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    container: { flex: 1, paddingHorizontal: Spacing['2xl'], paddingTop: Spacing['2xl'] },
    backButton: {
      width: 40, height: 40, borderRadius: Radius.md, backgroundColor: c.surface,
      alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start', marginBottom: Spacing.xl,
    },
    backArrow: {
      width: 9, height: 9, borderLeftWidth: 2, borderBottomWidth: 2,
      borderColor: c.text, transform: [{ rotate: '45deg' }], marginLeft: 3, marginBottom: 1,
    },
    header: { marginBottom: Spacing['3xl'], gap: Spacing.md, marginTop: 180 },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize['3xl'], color: c.text, letterSpacing: -0.5 },
    subtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textSecondary, lineHeight: FontSize.base * 1.6 },
    phoneHighlight: { fontFamily: FontFamily.semibold, color: c.text },
    otpRow: { flexDirection: 'row', gap: Spacing.sm, justifyContent: 'space-between' },
    otpBox: {
      width: BOX_SIZE, height: BOX_SIZE + 8, borderRadius: Radius.lg,
      borderWidth: 1.5, borderColor: c.border, backgroundColor: c.white,
      textAlign: 'center', fontFamily: FontFamily.bold, fontSize: FontSize['2xl'], color: c.text, ...Shadow.sm,
    },
    otpBoxFilled: { borderColor: c.primary, backgroundColor: c.primaryBg },
    otpBoxError: { borderColor: c.danger, backgroundColor: c.dangerBg },
    errorText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.danger, textAlign: 'center', marginTop: Spacing.md },
    consentRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: Spacing.sm,
      marginTop: Spacing.xl,
      paddingHorizontal: Spacing.xs,
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: Radius.sm,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.white,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 2,
    },
    checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },
    consentText: {
      flex: 1,
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      lineHeight: FontSize.sm * 1.5,
      color: c.textSecondary,
    },
    consentLink: {
      fontFamily: FontFamily.medium,
      color: c.primary,
      textDecorationLine: 'underline',
    },
    resendRow: { alignItems: 'center', marginTop: Spacing.xl },
    resendCountdown: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    resendCountdownNum: { fontFamily: FontFamily.semibold, color: c.text },
    resendLink: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.primary, textDecorationLine: 'underline' },
    bottom: { paddingHorizontal: Spacing['2xl'], paddingBottom: Spacing['2xl'], gap: Spacing.md, alignItems: 'center' },
    verifyButton: { width: '100%', height: 54, backgroundColor: c.primary, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center', ...Shadow.md },
    verifyButtonDisabled: { opacity: 0.45 },
    verifyButtonText: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: '#FFFFFF', letterSpacing: 0.2 },
    changeNumber: { paddingVertical: Spacing.xs },
    changeNumberText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.textSecondary },
  });
}
