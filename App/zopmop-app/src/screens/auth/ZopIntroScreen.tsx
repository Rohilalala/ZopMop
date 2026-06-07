import React, { useRef, useEffect, useCallback } from 'react';
import { StyleSheet, StatusBar } from 'react-native';
import LottieView from 'lottie-react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'ZopIntro'>;
};

export default function ZopIntroScreen({ navigation }: Props) {
  // Auth flow is locked to light (light-mode Lottie pages) — no dark variant.
  const c = lightColors;
  const ref = useRef<LottieView>(null);
  const fired = useRef(false);

  const finish = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    navigation.replace('HiZop');
  }, [navigation]);

  // Fallback: if onAnimationFinish never fires (known lottie-react-native
  // issue with .lottie files on Android), navigate after 4 seconds.
  useEffect(() => {
    const tid = setTimeout(finish, 4000);
    return () => clearTimeout(tid);
  }, [finish]);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={c.background} />
      <LottieView
        ref={ref}
        source={require('../../../assets/animation/intro.json')}
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
