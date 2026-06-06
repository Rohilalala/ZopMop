import React, { useRef } from 'react';
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

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={c.background} />
      <LottieView
        ref={ref}
        source={require('../../../assets/animation/intro.lottie')}
        autoPlay
        loop={false}
        resizeMode="cover"
        onAnimationFinish={() => navigation.replace('HiZop')}
        style={[styles.lottie, { backgroundColor: c.background }]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  lottie: { flex: 1, width: '100%', height: '100%' },
});
