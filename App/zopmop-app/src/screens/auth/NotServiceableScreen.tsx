import React, { useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors, authColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius } from '../../theme';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'NotServiceable'>;
  route: RouteProp<AuthStackParamList, 'NotServiceable'>;
};

export default function NotServiceableScreen({ navigation, route }: Props) {
  const { cityName, phone, name } = route.params;
  // Auth flow is locked to light (light-mode Lottie pages) — no dark variant.
  const c = authColors;
  const s = useMemo(() => createStyles(c), [c]);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 450, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Animated.View style={[s.container, { opacity, transform: [{ translateY }] }]}>

        {/* Illustration */}
        <View style={s.illustrationWrapper}>
          {/* Outer map shape */}
          <View style={s.mapShape}>
            {/* Location pin */}
            <View style={s.pinHead}>
              <View style={s.pinDot} />
            </View>
            <View style={s.pinTail} />
          </View>
          {/* Dashed expansion rings */}
          <View style={[s.dashedRing, s.ring1]} />
          <View style={[s.dashedRing, s.ring2]} />
          {/* Sparkle dots */}
          <View style={[s.sparkle, { top: 10, right: 24 }]} />
          <View style={[s.sparkle, s.sparkleSm, { bottom: 24, left: 20 }]} />
          <View style={[s.sparkle, s.sparkleSm, { top: 32, left: 8 }]} />
        </View>

        {/* Copy */}
        <View style={s.copyWrapper}>
          <Text style={s.heading}>Not in {cityName} yet</Text>
          <Text style={s.subheading}>
            ZopMop isn't available in {cityName} right now, but we're growing fast.{'\n'}
            We'll be serving your city soon!
          </Text>
        </View>

        {/* Expansion badge */}
        {/* TODO(post-expansion): replace with
             ALL_KNOWN_CITIES.filter(c => c.serviceable).map(c => c.name).join(', ')
             once ZopMop ships in more than one city (S29). */}
        <View style={s.badge}>
          <View style={s.badgeDot} />
          <Text style={s.badgeText}>Currently serving Gurugram</Text>
        </View>

        {/* CTA */}
        <View style={s.actions}>
          <TouchableOpacity
            style={s.retryButton}
            onPress={() => navigation.replace('Location', { phone, name })}
            activeOpacity={0.8}
          >
            <Text style={s.retryText}>Try a different location</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: c.background,
    },
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: Spacing['2xl'],
      gap: Spacing['2xl'],
    },

    // Illustration
    illustrationWrapper: {
      width: 180,
      height: 180,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    mapShape: {
      width: 88,
      height: 88,
      borderRadius: 20,
      backgroundColor: 'rgba(245,163,0,0.12)',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2,
    },
    pinHead: {
      width: 34,
      height: 34,
      borderRadius: Radius.full,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
      opacity: 0.5,
    },
    pinDot: {
      width: 12,
      height: 12,
      borderRadius: Radius.full,
      backgroundColor: '#FFFFFF',
    },
    pinTail: {
      width: 0,
      height: 0,
      borderLeftWidth: 9,
      borderRightWidth: 9,
      borderTopWidth: 15,
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent',
      borderTopColor: c.accent,
      opacity: 0.5,
      marginTop: -2,
    },
    dashedRing: {
      position: 'absolute',
      borderRadius: Radius.full,
      borderStyle: 'dashed',
      borderColor: c.accent,
      zIndex: 1,
    },
    ring1: {
      width: 120,
      height: 120,
      borderWidth: 1.5,
      opacity: 0.2,
    },
    ring2: {
      width: 160,
      height: 160,
      borderWidth: 1,
      opacity: 0.1,
    },
    sparkle: {
      position: 'absolute',
      width: 8,
      height: 8,
      borderRadius: Radius.full,
      backgroundColor: c.accent,
      opacity: 0.35,
      zIndex: 3,
    },
    sparkleSm: {
      width: 5,
      height: 5,
      opacity: 0.2,
    },

    // Copy
    copyWrapper: {
      alignItems: 'center',
      gap: Spacing.md,
      paddingHorizontal: Spacing.sm,
    },
    heading: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize['2xl'],
      color: c.text,
      textAlign: 'center',
      letterSpacing: -0.3,
    },
    subheading: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: FontSize.base * 1.65,
    },

    // Badge
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.xs,
      backgroundColor: c.successBg,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
    },
    badgeDot: {
      width: 7,
      height: 7,
      borderRadius: Radius.full,
      backgroundColor: c.success,
    },
    badgeText: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.success,
    },

    // Actions
    actions: {
      width: '100%',
      paddingHorizontal: Spacing.xs,
    },
    retryButton: {
      width: '100%',
      height: 52,
      borderRadius: Radius.xl,
      borderWidth: 1.5,
      borderColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    retryText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.md,
      color: c.accentOnSurface,
    },
  });
}
