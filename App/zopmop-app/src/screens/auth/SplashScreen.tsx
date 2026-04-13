import React, { useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Animated,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing } from '../../theme';
import { useColors, useTheme } from '../../context/ThemeContext';

interface Props {
  onReady: () => void;
}

export default function SplashScreen({ onReady }: Props) {
  const c = useColors();
  const { isDark } = useTheme();
  const s = useMemo(() => createStyles(c), [c]);
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
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={c.background} />
      <View style={s.container}>
        {/* Logo */}
        <Animated.View
          style={[
            s.logoWrapper,
            { opacity: logoOpacity, transform: [{ scale: logoScale }] },
          ]}
        >
          <Image
            source={require('../../../assets/logo.png')}
            style={s.logoImage}
            resizeMode="contain"
          />
        </Animated.View>

        {/* Brand text */}
        <Animated.View
          style={[
            s.brandWrapper,
            { opacity: textOpacity, transform: [{ translateY: textTranslateY }] },
          ]}
        >
          <Text style={s.brandText}>
            <Text style={s.brandZop}>Zop</Text>
            <Text style={s.brandMop}>Mop</Text>
          </Text>
          <Text style={s.tagline}>Home services, instantly.</Text>
        </Animated.View>
      </View>

      {/* Bottom progress indicator */}
      <View style={s.bottomBar}>
        <Animated.View style={[s.progressLine, { width: progressWidth }]} />
      </View>
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
      color: c.primary,
    },
    brandMop: {
      fontFamily: FontFamily.bold,
      color: c.text,
    },
    tagline: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.textSecondary,
      letterSpacing: 0.1,
    },
    bottomBar: {
      alignItems: 'center',
      paddingBottom: Spacing.lg,
    },
    progressLine: {
      height: 4,
      backgroundColor: c.primary,
      borderRadius: 2,
    },
  });
}
