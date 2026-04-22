import React, { useRef } from 'react';
import { StyleSheet, StatusBar } from 'react-native';
import LottieView from 'lottie-react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types/navigation';
import { useColors, useTheme } from '../../context/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'ZopIntro'>;
};

export default function ZopIntroScreen({ navigation }: Props) {
  const c = useColors();
  const { isDark } = useTheme();
  const ref = useRef<LottieView>(null);

  return (
    <>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={c.background} />
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
