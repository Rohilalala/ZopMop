import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Animated,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, FontFamily, FontSize, Spacing } from '../../theme';

interface Props {
  onReady: () => void;
}

export default function SplashScreen({ onReady }: Props) {
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.8)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textTranslateY = useRef(new Animated.Value(12)).current;
  const progressWidth = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Sequence: logo springs in → text fades up → progress bar fills → navigate
    Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.spring(logoScale, {
          toValue: 1,
          friction: 6,
          tension: 100,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 350,
          useNativeDriver: true,
        }),
        Animated.timing(textTranslateY, {
          toValue: 0,
          duration: 350,
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(200),
      Animated.timing(progressWidth, {
        toValue: 120,
        duration: 900,
        useNativeDriver: false,
      }),
    ]).start(() => {
      onReady();
    });
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.background} />
      <View style={styles.container}>
        {/* Logo */}
        <Animated.View
          style={[
            styles.logoWrapper,
            { opacity: logoOpacity, transform: [{ scale: logoScale }] },
          ]}
        >
          <Image
            source={require('../../../assets/logo.png')}
            style={styles.logoImage}
            resizeMode="contain"
          />
        </Animated.View>

        {/* Brand text */}
        <Animated.View
          style={[
            styles.brandWrapper,
            { opacity: textOpacity, transform: [{ translateY: textTranslateY }] },
          ]}
        >
          <Text style={styles.brandText}>
            <Text style={styles.brandZop}>Zop</Text>
            <Text style={styles.brandMop}>Mop</Text>
          </Text>
          <Text style={styles.tagline}>Home services, instantly.</Text>
        </Animated.View>
      </View>

      {/* Bottom progress indicator */}
      <View style={styles.bottomBar}>
        <Animated.View style={[styles.progressLine, { width: progressWidth }]} />
      </View>
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
  },
  logoWrapper: {
    marginBottom: Spacing.xl,
  },
  logoImage: {
    width: 108,
    height: 108,
  },
  brandWrapper: {
    alignItems: 'center',
    gap: Spacing.sm,
  },
  brandText: {
    fontSize: FontSize['4xl'],
    letterSpacing: -0.5,
  },
  brandZop: {
    fontFamily: FontFamily.extrabold,
    color: Colors.primary,
  },
  brandMop: {
    fontFamily: FontFamily.bold,
    color: Colors.text,
  },
  tagline: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    letterSpacing: 0.1,
  },
  bottomBar: {
    alignItems: 'center',
    paddingBottom: Spacing.lg,
  },
  progressLine: {
    height: 4,
    backgroundColor: Colors.primary,
    borderRadius: 2,
  },
});
