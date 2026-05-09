import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  
  Platform,
  InputAccessoryView,
  Animated,
  Easing,
  Keyboard,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getAuth, signInWithPhoneNumber } from '@react-native-firebase/auth';
import LottieView from 'lottie-react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { otpStore } from '../../utils/otpStore';
import { haptics } from '../../utils/haptics';
import { BASE_URL } from '../../api/config';
import { IndiaFlag } from '../../components/ui/IndiaFlag';
import { posthog } from '../../config/posthog';

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
  const [kbOpen, setKbOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const lottieRef = useRef<LottieView>(null);
  const fade = useRef(new Animated.Value(0)).current;
  const btnLift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const t = setTimeout(() => {
      Animated.timing(fade, {
        toValue: 1,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, 450);
    return () => clearTimeout(t);
  }, [fade]);

  useEffect(() => {
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEv, (e) => {
      setKbOpen(true);
      const kbH = e.endCoordinates.height;
      Animated.timing(btnLift, {
        toValue: -kbH + 32,
        duration: Platform.OS === 'ios' ? e.duration ?? 250 : 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    const hideSub = Keyboard.addListener(hideEv, (e) => {
      setKbOpen(false);
      Animated.timing(btnLift, {
        toValue: 0,
        duration: Platform.OS === 'ios' ? e?.duration ?? 250 : 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [btnLift]);

  const isValid = phone.replace(/\s/g, '').length === 10;

  async function handleSendOTP() {
    if (!isValid) { haptics.error(); return; }
    haptics.medium();
    setError('');
    setLoading(true);

    const fullPhone = `${COUNTRY_CODE}${phone.replace(/\s/g, '')}`;

    try {
      // Ask the backend whether this phone is new — drives the privacy-policy
      // checkbox on the OTP screen. Run in parallel with Firebase OTP send.
      // Failure (offline, cooldown 429, etc.) defaults isNewUser=false; the
      // verify-otp call still tolerates either branch.
      const isNewUserPromise = (async () => {
        try {
          const res = await fetch(`${BASE_URL}/auth/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: fullPhone }),
          });
          if (!res.ok) return false;
          const data = await res.json();
          return Boolean(data?.is_new_user);
        } catch {
          return false;
        }
      })();

      const firebaseAuth = getAuth();
      if (__DEV__) {
        firebaseAuth.settings.appVerificationDisabledForTesting = true;
      }
      // @ts-ignore
      const confirmation = await signInWithPhoneNumber(firebaseAuth, fullPhone);
      otpStore.set(confirmation);
      const isNewUser = await isNewUserPromise;
      posthog.capture('otp_requested', { is_new_user: isNewUser });
      navigation.navigate('OTPVerification', { phone: fullPhone, isNewUser });
    } catch (err: any) {
      const msg =
        err?.code === 'auth/invalid-phone-number'
          ? 'Invalid phone number. Please check and try again.'
          : err?.code === 'auth/too-many-requests'
            ? 'Too many attempts. Please try again later.'
            : `Failed to send verification code. (${err?.code ?? err?.message ?? 'unknown'})`;
      haptics.error();
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  function handleChange(text: string) {
    const digits = text.replace(/\D/g, '').slice(0, 10);
    const formatted =
      digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
    setPhone(formatted);
    if (error) setError('');
  }

  return (
    <View style={styles.root}>
      {/* Lottie background — plays once, holds on final frame */}
      <View style={styles.lottie} pointerEvents="none">
        <LottieView
          ref={lottieRef}
          source={require('../../../assets/animation/phone.lottie')}
          autoPlay
          loop={false}
          resizeMode="cover"
          style={styles.lottieInner}
        />
      </View>

      {Platform.OS === 'ios' && <InputAccessoryView nativeID="phone-input" />}

      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        {/* Top spacer — lottie mascot occupies this area */}
        <View style={styles.topSpacer} />

        {/* Content — title, subtitle, input, terms */}
        <Animated.View style={[styles.content, { opacity: fade }]}>
          <Text style={styles.title}>Enter your phone number</Text>
          <Text style={styles.subtitle}>
            We'll send a verification code to confirm it's you.
          </Text>

          <TouchableOpacity
            style={[styles.inputCard, error ? styles.inputCardError : null]}
            onPress={() => inputRef.current?.focus()}
            activeOpacity={1}
          >
            <View style={styles.countryCode}>
              <IndiaFlag size={18} />
              <Text style={styles.countryCodeText}>{COUNTRY_CODE}</Text>
              <View style={styles.dividerVertical} />
            </View>
            <TextInput
              ref={inputRef}
              style={styles.phoneInput}
              value={phone}
              onChangeText={handleChange}
              keyboardType="number-pad"
              placeholder="Enter mobile number"
              placeholderTextColor={c.textMuted}
              maxLength={11}
              returnKeyType="done"
              onSubmitEditing={handleSendOTP}
              inputAccessoryViewID="phone-input"
              autoFocus
            />
          </TouchableOpacity>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Terms — hidden via opacity while keyboard is up, keeps layout fixed */}
          <Text style={[styles.terms, { opacity: kbOpen ? 0 : 1 }]}>
            By continuing, you agree to our{' '}
            <Text style={styles.termsLink}>Terms of Service</Text> and{' '}
            <Text style={styles.termsLink}>Privacy Policy</Text>.
          </Text>
        </Animated.View>

        {/* Spacer flex pushes button to bottom, keyboard avoiding lifts with focus */}
        <View style={styles.bottomSpacer} />

        {/* CTA button — lifts above keyboard (only button moves, form stays put) */}
        <Animated.View
          style={[
            styles.bottom,
            { opacity: fade, transform: [{ translateY: btnLift }] },
          ]}
        >
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
              <LoadingBars color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.continueButtonText}>Send OTP</Text>
            )}
          </TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    lottie: {
      ...StyleSheet.absoluteFillObject,
    },
    lottieInner: {
      flex: 1,
      width: '100%',
      height: '100%',
    },
    kav: { flex: 1 },
    safe: { flex: 1 },
    topSpacer: {
      // Pushes content down past the mascot area of the lottie
      flex: 1.10,
    },
    content: {
      paddingHorizontal: 24,
    },
    title: {
      fontFamily: FontFamily.bold,
      fontSize: 28,
      lineHeight: 34,
      letterSpacing: -0.5,
      color: c.text,
      textAlign: 'center',
    },
    subtitle: {
      fontFamily: FontFamily.regular,
      fontSize: 15,
      lineHeight: 24,
      color: c.textSecondary,
      marginTop: 8,
      textAlign: 'center',
    },
    inputCard: {
      marginTop: 24,
      flexDirection: 'row',
      alignItems: 'center',
      height: 60,
      borderRadius: 16,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.white,
      paddingHorizontal: 16,
      gap: 8,
    },
    inputCardError: { borderColor: c.danger },
    countryCode: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    countryCodeText: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: c.text },
    dividerVertical: { width: 1, height: 24, backgroundColor: c.border, marginLeft: 4 },
    phoneInput: {
      flex: 1,
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.xl,
      color: c.text,
      letterSpacing: 1,
      paddingVertical: 0,
    },
    errorText: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.danger,
      marginTop: 8,
      textAlign: 'center',
    },
    terms: {
      fontFamily: FontFamily.regular,
      fontSize: 13,
      color: c.textMuted,
      marginTop: 20,
      lineHeight: 21,
      textAlign: 'center',
    },
    termsLink: { color: c.primary, fontFamily: FontFamily.medium },
    bottomSpacer: { flex: 1 },
    bottom: {
      paddingHorizontal: 24,
      paddingBottom: 16,
    },
    continueButton: {
      height: 54,
      backgroundColor: c.primary,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    continueButtonDisabled: { opacity: 0.45 },
    continueButtonText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.md,
      color: '#FFFFFF',
      letterSpacing: 0.2,
    },
  });
}
