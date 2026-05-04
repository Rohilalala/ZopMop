// NotServiceableScreen — dark home pattern.
// Pulsing pin illustration + apology copy + "currently serving" card + CTA.

import React from 'react';
import {
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

interface Props {
  locationName: string;
  onChangeLocation: () => void;
}

export default function NotServiceableScreen({ locationName, onChangeLocation }: Props) {
  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <Bloom />

      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <View style={s.container}>
          <View style={s.illustrationWrap}>
            <View style={s.pingRing2} />
            <View style={s.pingRing1} />
            <View style={s.pinCircle}>
              <Feather name="map-pin" size={32} color="#F5A300" />
            </View>
          </View>

          <Text style={s.title}>We're not in{'\n'}your area yet</Text>
          <Text style={s.subtitle}>
            ZopMop isn't available in{' '}
            <Text style={s.locationBold}>{locationName}</Text>
            {' '}right now. We're expanding fast — check back soon.
          </Text>

          <GlassCard radius={20} style={s.servedCard}>
            <Text style={s.servedLabel}>Currently serving</Text>
            <View style={s.cityRow}>
              <Feather name="zap" size={16} color="#F5A300" />
              <Text style={s.cityName}>Gurugram</Text>
              <View style={s.liveBadge}>
                <View style={s.liveDot} />
                <Text style={s.liveText}>LIVE</Text>
              </View>
            </View>
          </GlassCard>

          <PressFx style={s.primaryBtn} onPress={onChangeLocation}>
            <Text style={s.primaryBtnText}>Change location</Text>
          </PressFx>

          <Text style={s.comingSoon}>More cities coming soon</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 18,
  },

  illustrationWrap: {
    width: 140, height: 140,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  pinCircle: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: 'rgba(245,163,0,0.14)',
    borderWidth: 1, borderColor: 'rgba(245,163,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
    zIndex: 3,
  },
  pingRing1: {
    position: 'absolute',
    width: 104, height: 104, borderRadius: 52,
    borderWidth: 1, borderColor: 'rgba(245,163,0,0.18)',
  },
  pingRing2: {
    position: 'absolute',
    width: 132, height: 132, borderRadius: 66,
    borderWidth: 1, borderColor: 'rgba(245,163,0,0.08)',
  },

  title: {
    ...fontExtra,
    fontSize: 28,
    color: '#FFFFFF',
    textAlign: 'center',
    letterSpacing: -0.6,
    lineHeight: 32,
  },
  subtitle: {
    ...fontMed,
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    lineHeight: 21,
    marginTop: -4,
    paddingHorizontal: 8,
  },
  locationBold: { ...fontSemi, color: '#FFFFFF' },

  servedCard: {
    width: '100%',
    paddingHorizontal: 18,
    paddingVertical: 14,
    marginTop: 6,
  },
  servedLabel: {
    ...fontBold,
    fontSize: 10,
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  cityRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cityName: {
    ...fontBold,
    fontSize: 15,
    color: '#FFFFFF',
    flex: 1,
    letterSpacing: -0.2,
  },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(34,197,94,0.16)',
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 99,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#22C55E' },
  liveText: {
    ...fontBold,
    fontSize: 9,
    color: '#22C55E',
    letterSpacing: 0.6,
  },

  primaryBtn: {
    width: '100%',
    backgroundColor: '#F5A300',
    borderRadius: 18,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: {
    ...fontBold,
    fontSize: 14.5,
    color: '#0A0A0A',
    letterSpacing: 0.1,
  },

  comingSoon: {
    ...fontMed,
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 2,
  },
});
