import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useColors, useTheme } from '../../context/ThemeContext';

interface Props {
  locationName: string;
  onChangeLocation: () => void;
}

export default function NotServiceableScreen({ locationName, onChangeLocation }: Props) {
  const c = useColors();
  const { isDark } = useTheme();
  const s = useMemo(() => createStyles(c), [c]);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <View style={s.container}>
        {/* Illustration */}
        <View style={s.illustrationWrap}>
          <View style={s.circle}>
            <Text style={s.emoji}>📍</Text>
          </View>
          <View style={s.pingRing1} />
          <View style={s.pingRing2} />
        </View>

        {/* Text */}
        <Text style={s.title}>We're not in{'\n'}your area yet</Text>
        <Text style={s.subtitle}>
          ZopMop isn't available in{' '}
          <Text style={s.locationBold}>{locationName}</Text>
          {' '}right now. We're expanding fast — check back soon!
        </Text>

        {/* Currently serving */}
        <View style={s.servedCard}>
          <Text style={s.servedLabel}>Currently serving</Text>
          <View style={s.cityRow}>
            <Text style={s.cityEmoji}>🏙️</Text>
            <Text style={s.cityName}>Gurugram</Text>
            <View style={s.liveBadge}>
              <View style={s.liveDot} />
              <Text style={s.liveText}>Live</Text>
            </View>
          </View>
        </View>

        {/* Actions */}
        <TouchableOpacity style={s.primaryBtn} activeOpacity={0.85} onPress={onChangeLocation}>
          <Text style={s.primaryBtnText}>Change Location</Text>
        </TouchableOpacity>

        <Text style={s.comingSoon}>More cities coming soon ✨</Text>
      </View>
    </SafeAreaView>
  );
}

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 16,
    },

    // Pulsing pin illustration
    illustrationWrap: {
      width: 120, height: 120,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: 8,
    },
    circle: {
      width: 80, height: 80, borderRadius: 40,
      backgroundColor: `${c.primary}15`,
      borderWidth: 2, borderColor: `${c.primary}30`,
      alignItems: 'center', justifyContent: 'center',
      zIndex: 3,
    },
    emoji: { fontSize: 36 },
    pingRing1: {
      position: 'absolute',
      width: 100, height: 100, borderRadius: 50,
      borderWidth: 1.5, borderColor: `${c.primary}20`,
    },
    pingRing2: {
      position: 'absolute',
      width: 120, height: 120, borderRadius: 60,
      borderWidth: 1, borderColor: `${c.primary}10`,
    },

    title: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize['3xl'],
      color: c.text,
      textAlign: 'center',
      letterSpacing: -0.5,
      lineHeight: FontSize['3xl'] * 1.2,
    },
    subtitle: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 24,
      marginTop: -4,
    },
    locationBold: {
      fontFamily: FontFamily.semibold,
      color: c.text,
    },

    servedCard: {
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      borderWidth: 1, borderColor: c.border,
      paddingHorizontal: 20, paddingVertical: 14,
      width: '100%',
      marginTop: 4,
      ...Shadow.sm,
    },
    servedLabel: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
      marginBottom: 8,
    },
    cityRow: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
    },
    cityEmoji: { fontSize: 20 },
    cityName: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: c.text,
      flex: 1,
    },
    liveBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: `${c.success}15`,
      paddingHorizontal: 8, paddingVertical: 4,
      borderRadius: Radius.full,
    },
    liveDot: {
      width: 6, height: 6, borderRadius: 3,
      backgroundColor: c.success,
    },
    liveText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.xs,
      color: c.success,
    },

    primaryBtn: {
      width: '100%',
      backgroundColor: c.primary,
      borderRadius: Radius.xl,
      paddingVertical: 15,
      alignItems: 'center',
      marginTop: 8,
      ...Shadow.sm,
    },
    primaryBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: '#FFFFFF',
    },

    comingSoon: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textMuted,
      marginTop: 4,
    },
  });
}
