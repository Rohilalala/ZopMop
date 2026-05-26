// RoomiesWelcomeScreen — dark home pattern.
// Celebration moment after joining a household: animated home glyph,
// group name + saved address chip, "Let's go" CTA.

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';

import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

type Props = NativeStackScreenProps<MainStackParamList, 'RoomiesWelcome'>;

export default function RoomiesWelcomeScreen({ route }: Props) {
  const { isDark } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { groupName, addressLabel, addressAdded } = route.params;

  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.85)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 6, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <Animated.View style={[s.body, { opacity, transform: [{ scale }] }]}>
          <View style={s.iconWrap}>
            <View style={s.iconRing} />
            <View style={s.iconCircle}>
              <Feather name="home" size={44} color="#F5A300" />
            </View>
          </View>

          <Text style={s.welcome}>Welcome home.</Text>
          <Text style={s.groupName}>{groupName}</Text>

          <GlassCard radius={99} style={s.addressChip}>
            <Feather name="map-pin" size={13} color="rgba(255,255,255,0.65)" />
            <Text style={s.addressText}>{addressLabel}</Text>
          </GlassCard>

          {addressAdded && (
            <Text style={s.addressAddedNote}>
              Saved to your addresses.
            </Text>
          )}
        </Animated.View>

        <PressFx style={s.letsGoBtn} onPress={() => navigation.navigate('Home')}>
          <Text style={s.letsGoBtnText}>Let's go</Text>
        </PressFx>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },

  iconWrap: {
    width: 140, height: 140,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 28,
  },
  iconRing: {
    position: 'absolute',
    width: 140, height: 140, borderRadius: 70,
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.18)',
  },
  iconCircle: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: 'rgba(245,163,0,0.14)',
    borderWidth: 1, borderColor: 'rgba(245,163,0,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },

  welcome: {
    ...fontExtra,
    fontSize: 30,
    color: '#FFFFFF',
    letterSpacing: -0.8,
    textAlign: 'center',
    marginBottom: 4,
  },
  groupName: {
    ...fontBold,
    fontSize: 18,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    marginBottom: 22,
    letterSpacing: -0.3,
  },

  addressChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  addressText: {
    ...fontMed,
    fontSize: 12.5,
    color: '#FFFFFF',
  },
  addressAddedNote: {
    ...fontMed,
    fontSize: 12,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    marginTop: 12,
  },

  letsGoBtn: {
    marginHorizontal: 20,
    marginBottom: 24,
    backgroundColor: '#F5A300',
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
  },
  letsGoBtnText: {
    ...fontBold,
    fontSize: 14.5,
    color: '#0A0A0A',
    letterSpacing: 0.2,
  },
});
