import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import LottieView from 'lottie-react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { setNeedsWelcome } from '../../utils/pendingAuthStore';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Welcome'>;
  route: RouteProp<AuthStackParamList, 'Welcome'>;
};

const AUTO_ADVANCE_MS = 2600;

export default function WelcomeScreen({ route }: Props) {
  // Auth flow is locked to light (light-mode Lottie pages) — no dark variant.
  const c = lightColors;
  const styles = useMemo(() => createStyles(c), [c]);

  const { user } = useAuth();
  const name = user?.name?.trim() || route.params.name?.trim() || 'friend';
  const firstName = name.split(/\s+/)[0];

  const titleOpacity = useRef(new Animated.Value(0)).current;
  const titleY = useRef(new Animated.Value(18)).current;
  const subOpacity = useRef(new Animated.Value(0)).current;
  const lottieRef = useRef<LottieView>(null);

  useEffect(() => {
    Animated.sequence([
      Animated.delay(450),
      Animated.parallel([
        Animated.timing(titleOpacity, {
          toValue: 1,
          duration: 420,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(titleY, {
          toValue: 0,
          friction: 7,
          tension: 80,
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(subOpacity, {
        toValue: 1,
        duration: 380,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();

    // Clearing the welcome flag is what moves the user on: App.tsx swaps
    // AuthNavigator → MainNavigator, which lands them per their backend
    // role. No role selection — roles are assigned in the DB via the CRM.
    const t = setTimeout(() => setNeedsWelcome(false), AUTO_ADVANCE_MS);
    return () => clearTimeout(t);
  }, [titleOpacity, titleY, subOpacity]);

  return (
    <View style={styles.root}>
      {/* Lottie background — mascot only */}
      <View style={styles.lottieWrap} pointerEvents="none">
        <LottieView
          ref={lottieRef}
          source={require('../../../assets/animation/hi-name.json')}
          autoPlay
          loop={false}
          resizeMode="cover"
          style={styles.lottie}
        />
      </View>

      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.content}>
          <Animated.Text
            style={[
              styles.overline,
              { opacity: titleOpacity, transform: [{ translateY: titleY }] },
            ]}
          >
            Welcome to <Text style={styles.subtitleBrandZop}>Zop</Text>
            <Text style={styles.subtitleBrandMop}>Mop</Text>
          </Animated.Text>
          <Animated.Text
            style={[
              styles.title,
              { opacity: titleOpacity, transform: [{ translateY: titleY }] },
            ]}
            numberOfLines={2}
          >
            Hi {firstName}!
          </Animated.Text>
          <Animated.Text style={[styles.subtitle, { opacity: subOpacity }]}>
            Let's go <Text style={styles.subtitleBrandZop}>Zop</Text>
            <Text style={styles.subtitleBrandMop}>Mop</Text>ping.
          </Animated.Text>
        </View>
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
    content: {
      paddingHorizontal: Spacing['2xl'],
      paddingTop: Spacing['4xl'],
      gap: Spacing.md,
    },
    overline: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.xl,
      color: c.text,
      letterSpacing: -0.3,
    },
    title: {
      fontFamily: FontFamily.extrabold,
      fontSize: 72,
      lineHeight: 78,
      color: c.text,
      letterSpacing: -1.6,
    },
    subtitle: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize['2xl'],
      color: c.text,
      letterSpacing: -0.5,
    },
    subtitleBrandZop: {
      fontFamily: FontFamily.extrabold,
      color: c.accent,
    },
    subtitleBrandMop: {
      fontFamily: FontFamily.extrabold,
      color: c.text,
    },
  });
}
