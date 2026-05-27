import React, { useRef, useEffect, useCallback } from 'react';
import { StyleSheet, StatusBar } from 'react-native';
import LottieView from 'lottie-react-native';
import { useColors, useTheme } from '../../context/ThemeContext';

interface Props {
  onReady: () => void;
}

export default function SplashScreen({ onReady }: Props) {
  const c = useColors();
  const { isDark } = useTheme();
  const ref = useRef<LottieView>(null);
  const fired = useRef(false);

  const finish = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    onReady();
  }, [onReady]);

  // Fallback: if onAnimationFinish never fires, dismiss after 4 seconds.
  useEffect(() => {
    const tid = setTimeout(finish, 4000);
    return () => clearTimeout(tid);
  }, [finish]);

  return (
    <>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={c.background} />
      <LottieView
        ref={ref}
        source={require('../../../assets/animation/splash.json')}
        autoPlay
        loop={false}
        resizeMode="cover"
        onAnimationFinish={finish}
        style={[styles.lottie, { backgroundColor: c.background }]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  lottie: { flex: 1, width: '100%', height: '100%' },
});
