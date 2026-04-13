import React, { useMemo, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  InputAccessoryView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getAuth, signInWithPhoneNumber } from '@react-native-firebase/auth';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { otpStore } from '../../utils/otpStore';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'PhoneEntry'>;
};

const COUNTRY_CODE = '+91';

export default function PhoneEntryScreen({ navigation }: Props) {
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<TextInput>(null);

  const isValid = phone.replace(/\s/g, '').length === 10;

  async function handleSendOTP() {
    if (!isValid) return;
    setError('');
    setLoading(true);

    const fullPhone = `${COUNTRY_CODE}${phone.replace(/\s/g, '')}`;

    try {
      const firebaseAuth = getAuth();
      // In dev builds, disable reCAPTCHA/app verification so Firebase sends the OTP
      // directly without opening a webpage. Real OTPs are still sent and must be entered.
      // This flag only skips the app attestation step — not the actual OTP check.
      if (__DEV__) {
        firebaseAuth.settings.appVerificationDisabledForTesting = true;
      }
      // @ts-ignore — react-native-firebase's modular signInWithPhoneNumber does not
      // require an ApplicationVerifier on native; the web SDK type definition is wrong here.
      const confirmation = await signInWithPhoneNumber(firebaseAuth, fullPhone);
      otpStore.set(confirmation);
      navigation.navigate('OTPVerification', { phone: fullPhone });
    } catch (err: any) {
      const msg =
        err?.code === 'auth/invalid-phone-number'
          ? 'Invalid phone number. Please check and try again.'
          : err?.code === 'auth/too-many-requests'
          ? 'Too many attempts. Please try again later.'
          : `Failed to send verification code. (${err?.code ?? err?.message ?? 'unknown'})`;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  // Format as: 98765 43210
  function handleChange(text: string) {
    const digits = text.replace(/\D/g, '').slice(0, 10);
    const formatted =
      digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
    setPhone(formatted);
    if (error) setError('');
  }

  return (
    <>
    {Platform.OS === 'ios' && <InputAccessoryView nativeID="phone-input" />}
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          bounces={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.logoMark}>
              <Text style={styles.logoMarkText}>Z</Text>
            </View>
            <Text style={styles.title}>Enter your phone number</Text>
            <Text style={styles.subtitle}>
              We'll send a verification code to confirm it's you.
            </Text>
          </View>

          {/* Input card */}
          <TouchableOpacity
            style={[styles.inputCard, error ? styles.inputCardError : null]}
            onPress={() => inputRef.current?.focus()}
            activeOpacity={1}
          >
            {/* Country code */}
            <View style={styles.countryCode}>
              <Text style={styles.flag}>🇮🇳</Text>
              <Text style={styles.countryCodeText}>{COUNTRY_CODE}</Text>
              <View style={styles.dividerVertical} />
            </View>

            {/* Phone input */}
            <TextInput
              ref={inputRef}
              style={styles.phoneInput}
              value={phone}
              onChangeText={handleChange}
              keyboardType="number-pad"
              placeholder="98765 43210"
              placeholderTextColor={c.textMuted}
              maxLength={11} // 10 digits + 1 space
              returnKeyType="done"
              onSubmitEditing={handleSendOTP}
              inputAccessoryViewID="phone-input"
              autoFocus
            />
          </TouchableOpacity>

          {/* Error */}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Terms note */}
          <Text style={styles.terms}>
            By continuing, you agree to our{' '}
            <Text style={styles.termsLink}>Terms of Service</Text> and{' '}
            <Text style={styles.termsLink}>Privacy Policy</Text>.
          </Text>
        </ScrollView>

        {/* CTA */}
        <View style={styles.bottom}>
          <TouchableOpacity
            style={[
              styles.continueButton,
              (!isValid || loading) && styles.continueButtonDisabled,
            ]}
            onPress={handleSendOTP}
            disabled={!isValid || loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.continueButtonText}>Send OTP</Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
    </>
  );
}

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    scroll: { flexGrow: 1, paddingHorizontal: Spacing['2xl'], paddingTop: Spacing['4xl'] },
    header: { marginBottom: Spacing['3xl'], gap: Spacing.md },
    logoMark: {
      width: 44, height: 44, borderRadius: Radius.lg,
      backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.sm,
    },
    logoMarkText: { fontFamily: FontFamily.extrabold, fontSize: FontSize.xl, color: '#FFFFFF' },
    title: { fontFamily: FontFamily.bold, fontSize: FontSize['3xl'], color: c.text, letterSpacing: -0.5, lineHeight: FontSize['3xl'] * 1.2 },
    subtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textSecondary, lineHeight: FontSize.base * 1.6 },
    inputCard: {
      flexDirection: 'row', alignItems: 'center', backgroundColor: c.white,
      borderRadius: Radius.xl, borderWidth: 1.5, borderColor: c.border,
      height: 60, paddingHorizontal: Spacing.base, gap: Spacing.sm, ...Shadow.sm,
    },
    inputCardError: { borderColor: c.danger },
    countryCode: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
    flag: { fontSize: 20 },
    countryCodeText: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: c.text },
    dividerVertical: { width: 1, height: 24, backgroundColor: c.border, marginLeft: Spacing.xs },
    phoneInput: { flex: 1, fontFamily: FontFamily.semibold, fontSize: FontSize.xl, color: c.text, letterSpacing: 1, paddingVertical: 0 },
    errorText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.danger, marginTop: Spacing.sm, marginLeft: Spacing.xs },
    terms: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted, marginTop: Spacing.xl, lineHeight: FontSize.sm * 1.6 },
    termsLink: { color: c.primary, fontFamily: FontFamily.medium },
    bottom: { paddingHorizontal: Spacing['2xl'], paddingBottom: Spacing['2xl'] },
    continueButton: { height: 54, backgroundColor: c.primary, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center', ...Shadow.md },
    continueButtonDisabled: { opacity: 0.45 },
    continueButtonText: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: '#FFFFFF', letterSpacing: 0.2 },
  });
}
