import React, { useRef } from 'react';
import { StyleSheet, StatusBar } from 'react-native';
import LottieView from 'lottie-react-native';
import { lightColors } from '../../theme/colors';

interface Props {
  onReady: () => void;
}

export default function SplashScreen({ onReady }: Props) {
  // Auth flow is locked to light (light-mode Lottie pages) — no dark variant.
  const c = lightColors;
  const ref = useRef<LottieView>(null);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={c.background} />
      <LottieView
        ref={ref}
        source={require('../../../assets/animation/splash.lottie')}
        autoPlay
        loop={false}
        resizeMode="cover"
        onAnimationFinish={onReady}
        style={[styles.lottie, { backgroundColor: c.background }]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  lottie: { flex: 1, width: '100%', height: '100%' },
});
