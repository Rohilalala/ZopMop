import React, { useRef, useEffect } from 'react';
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
import { Colors, FontFamily, FontSize, Spacing, Radius } from '../../theme';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'NotServiceable'>;
  route: RouteProp<AuthStackParamList, 'NotServiceable'>;
};

export default function NotServiceableScreen({ navigation, route }: Props) {
  const { cityName } = route.params;
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 450, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <Animated.View style={[styles.container, { opacity, transform: [{ translateY }] }]}>

        {/* Illustration */}
        <View style={styles.illustrationWrapper}>
          {/* Outer map shape */}
          <View style={styles.mapShape}>
            {/* Location pin */}
            <View style={styles.pinHead}>
              <View style={styles.pinDot} />
            </View>
            <View style={styles.pinTail} />
          </View>
          {/* Dashed expansion rings */}
          <View style={[styles.dashedRing, styles.ring1]} />
          <View style={[styles.dashedRing, styles.ring2]} />
          {/* Sparkle dots */}
          <View style={[styles.sparkle, { top: 10, right: 24 }]} />
          <View style={[styles.sparkle, styles.sparkleSm, { bottom: 24, left: 20 }]} />
          <View style={[styles.sparkle, styles.sparkleSm, { top: 32, left: 8 }]} />
        </View>

        {/* Copy */}
        <View style={styles.copyWrapper}>
          <Text style={styles.heading}>Not in {cityName} yet</Text>
          <Text style={styles.subheading}>
            ZopMop isn't available in {cityName} right now, but we're growing fast.{'\n'}
            We'll be serving your city soon!
          </Text>
        </View>

        {/* Expansion badge */}
        <View style={styles.badge}>
          <View style={styles.badgeDot} />
          <Text style={styles.badgeText}>Currently serving Gurugram</Text>
        </View>

        {/* CTA */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => navigation.replace('Location')}
            activeOpacity={0.8}
          >
            <Text style={styles.retryText}>Try a different location</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
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
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  pinHead: {
    width: 34,
    height: 34,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.5,
  },
  pinDot: {
    width: 12,
    height: 12,
    borderRadius: Radius.full,
    backgroundColor: Colors.white,
  },
  pinTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderTopWidth: 15,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: Colors.primary,
    opacity: 0.5,
    marginTop: -2,
  },
  dashedRing: {
    position: 'absolute',
    borderRadius: Radius.full,
    borderStyle: 'dashed',
    borderColor: Colors.primary,
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
    backgroundColor: Colors.primary,
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
    color: Colors.text,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  subheading: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: FontSize.base * 1.65,
  },

  // Badge
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    backgroundColor: Colors.successBg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
  },
  badgeDot: {
    width: 7,
    height: 7,
    borderRadius: Radius.full,
    backgroundColor: Colors.success,
  },
  badgeText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.success,
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
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.primary,
  },
});
