import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  
  Platform,
  Animated,
  Easing,
  Keyboard,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import LottieView from 'lottie-react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { updateMe } from '../../api/users';
import { useAuth } from '../../context/AuthContext';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'NameEntry'>;
  route: RouteProp<AuthStackParamList, 'NameEntry'>;
};

const NAME_MAX_LENGTH = 50;

function sanitizeName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M}'\- ]/gu, '');
}

export default function NameEntryScreen({ navigation, route }: Props) {
  const { phone } = route.params;
  const { token, updateUser } = useAuth();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<TextInput>(null);
  const lottieRef = useRef<LottieView>(null);
  const fade = useRef(new Animated.Value(0)).current;
  const btnLift = useRef(new Animated.Value(0)).current;

  const sanitized = sanitizeName(name);
  const isValid = sanitized.length >= 2 && sanitized.length <= NAME_MAX_LENGTH;

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
      const kbH = e.endCoordinates.height;
      Animated.timing(btnLift, {
        toValue: -kbH + 32,
        duration: Platform.OS === 'ios' ? e.duration ?? 250 : 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    const hideSub = Keyboard.addListener(hideEv, (e) => {
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

  async function handleContinue() {
    if (!isValid) return;
    setError('');
    setLoading(true);

    try {
      if (token) {
        const updatedUser = await updateMe(token, sanitized);
        updateUser(updatedUser);
      }
      navigation.replace('Location', { phone, name: sanitized });
    } catch {
      navigation.replace('Location', { phone, name: sanitized });
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.root}>
      {/* Lottie background — mascot only */}
      <View style={styles.lottieWrap} pointerEvents="none">
        <LottieView
          ref={lottieRef}
          source={require('../../../assets/animation/enter-name.lottie')}
          autoPlay
          loop={false}
          resizeMode="cover"
          style={styles.lottie}
        />
      </View>

      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.topSpacer} />

        <Animated.View style={[styles.content, { opacity: fade }]}>
          <Text style={styles.title}>What's your name?</Text>
          <Text style={styles.subtitle}>
            We'll use this to personalise your experience.
          </Text>

          <TouchableOpacity
            style={[styles.inputCard, error ? styles.inputCardError : null]}
            onPress={() => inputRef.current?.focus()}
            activeOpacity={1}
          >
            <TextInput
              ref={inputRef}
              style={styles.nameInput}
              value={name}
              onChangeText={(t) => { setName(t); if (error) setError(''); }}
              keyboardType="default"
              placeholder="Your full name"
              placeholderTextColor={c.textMuted}
              maxLength={60}
              returnKeyType="done"
              onSubmitEditing={handleContinue}
              autoCapitalize="words"
            />
          </TouchableOpacity>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </Animated.View>

        <View style={styles.bottomSpacer} />

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
            onPress={handleContinue}
            disabled={!isValid || loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <LoadingBars color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.continueButtonText}>Continue</Text>
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
    lottieWrap: { ...StyleSheet.absoluteFillObject },
    lottie: { flex: 1, width: '100%', height: '100%' },
    safe: { flex: 1 },
    topSpacer: { flex: 1.2 },
    content: { paddingHorizontal: 24 },
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
      borderRadius: Radius.xl,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.white,
      paddingHorizontal: Spacing.base,
      ...Shadow.sm,
    },
    inputCardError: { borderColor: c.danger },
    nameInput: {
      flex: 1,
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.xl,
      color: c.text,
      paddingVertical: 0,
    },
    errorText: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.danger,
      marginTop: Spacing.sm,
      textAlign: 'center',
    },
    bottomSpacer: { flex: 1 },
    bottom: { paddingHorizontal: 24, paddingBottom: 16 },
    continueButton: {
      height: 54,
      backgroundColor: c.primary,
      borderRadius: Radius.xl,
      alignItems: 'center',
      justifyContent: 'center',
      ...Shadow.md,
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
