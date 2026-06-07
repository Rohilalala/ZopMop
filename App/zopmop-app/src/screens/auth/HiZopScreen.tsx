import React, { useRef, useState, useEffect } from 'react';
import {
  StyleSheet,
  StatusBar,
  View,
  TouchableOpacity,
  Animated,
  Easing,
  Dimensions,
} from 'react-native';
import LottieView from 'lottie-react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'HiZop'>;
};

const { height: SH } = Dimensions.get('window');

export default function HiZopScreen({ navigation }: Props) {
  // Auth flow is locked to light (light-mode Lottie pages) — no dark variant.
  const c = lightColors;
  const ref = useRef<LottieView>(null);
  const [done, setDone] = useState(false);
  const btnOpacity = useRef(new Animated.Value(0)).current;

  // Fallback: if onAnimationFinish never fires (known lottie-react-native
  // issue with .lottie files on Android), show the button after 4 seconds.
  useEffect(() => {
    const tid = setTimeout(() => setDone(true), 4000);
    return () => clearTimeout(tid);
  }, []);

  useEffect(() => {
    if (!done) return;
    Animated.timing(btnOpacity, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [done, btnOpacity]);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={c.background} />
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <LottieView
          ref={ref}
          source={require('../../../assets/animation/hi-zop.json')}
          autoPlay
          loop={false}
          resizeMode="cover"
          onAnimationFinish={() => setDone(true)}
          style={styles.lottie}
        />

        {/* Rounded-square CTA button — sits right of "Hi! I'm Zop" text */}
        <Animated.View
          style={[styles.btnWrap, { opacity: btnOpacity }]}
          pointerEvents={done ? 'auto' : 'none'}
        >
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: c.accent }]}
            activeOpacity={0.85}
            onPress={() => navigation.replace('PhoneEntry')}
          >
            <View style={styles.arrow} />
          </TouchableOpacity>
        </Animated.View>
      </View>
    </>
  );
}

const BTN_SIZE = 68;

const styles = StyleSheet.create({
  root: { flex: 1 },
  lottie: { flex: 1, width: '100%', height: '100%' },
  btnWrap: {
    position: 'absolute',
    right: 24,
    // Aligns with "Hi! / I'm Zop" text block (~SH * 0.78-0.82 in Figma)
    bottom: SH * 0.18,
  },
  btn: {
    width: BTN_SIZE,
    height: BTN_SIZE,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
  },
  arrow: {
    width: 16,
    height: 16,
    borderRightWidth: 3,
    borderTopWidth: 3,
    borderColor: '#0D0D0F',
    transform: [{ rotate: '45deg' }],
    marginLeft: -4,
  },
});
