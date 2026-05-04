import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import LottieView from 'lottie-react-native';
import { FontFamily } from '../theme';
import { PrimaryButton } from './PrimaryButton';

type Props = {
  title: string;
  subtitle?: string;
  ctaLabel?: string;
  onCtaPress?: () => void;
  lottieSource?: any;
  /** Custom illustration. When provided, replaces the default lottie entirely
   *  — used by screens that prefer a Zop SVG (e.g. Bookings empty state). */
  illustration?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const DEFAULT_LOTTIE = require('../../assets/animation/lookaway.lottie');

export function EmptyState({
  title,
  subtitle,
  ctaLabel,
  onCtaPress,
  lottieSource,
  illustration,
  style,
  testID,
}: Props) {
  return (
    <View style={[styles.wrap, style]} testID={testID}>
      {illustration ? (
        <View style={styles.illustration}>{illustration}</View>
      ) : (
        <LottieView
          source={lottieSource ?? DEFAULT_LOTTIE}
          autoPlay
          loop
          style={styles.lottie}
        />
      )}
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {ctaLabel && onCtaPress ? (
        <PrimaryButton label={ctaLabel} onPress={onCtaPress} style={styles.cta} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  lottie: {
    width: 180,
    height: 180,
    marginBottom: 8,
  },
  illustration: {
    width: 180,
    height: 180,
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: 18,
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 6,
  },
  subtitle: {
    fontFamily: FontFamily.regular,
    fontSize: 14,
    color: 'rgba(255,255,255,0.55)',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  cta: {
    minWidth: 220,
  },
});
