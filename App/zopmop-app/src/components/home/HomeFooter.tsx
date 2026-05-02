// HomeFooter — schedule card + trust strip. Mirrors the design's bottom-of-feed
// pair (`.schedule` + `.trust`) verbatim. No FAQ accordion, no editorial sign-off
// — those weren't in the home design and added visual noise.

import React from 'react';
import { Dimensions, View, Text, type TextStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { PressFx } from '../ui/PressFx';
import { GlassCard } from './GlassCard';

const { width: SCREEN_W } = Dimensions.get('window');

const fontReg:   TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

export function HomeFooter() {
  return (
    <View style={{ marginTop: 14, paddingBottom: 16 }}>
      <ScheduleCard />
      <TrustStrip />
      <Signoff />
    </View>
  );
}

// ── Schedule card ────────────────────────────────────────────────────────────
// `.schedule` — glass surface, amber-tinted icon tile, title + sub + chevron.

function ScheduleCard() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  return (
    <PressFx
      onPress={() => navigation.navigate('AllServices')}
      style={{ marginHorizontal: 20 }}
    >
      <GlassCard
        radius={16}
        style={{
          padding: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            backgroundColor: 'rgba(245,163,0,0.12)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name="calendar" size={18} color="#F5A300" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[fontBold, { fontSize: 14, color: '#FFFFFF' }]}>Book for later</Text>
          <Text
            style={[
              fontReg,
              { fontSize: 11.5, color: 'rgba(255,255,255,0.5)', marginTop: 2 },
            ]}
          >
            Pick your own time — up to 7 days ahead
          </Text>
        </View>
        <Text style={{ fontSize: 22, color: 'rgba(255,255,255,0.4)', fontWeight: '500' }}>
          ›
        </Text>
      </GlassCard>
    </PressFx>
  );
}

// ── Trust strip ──────────────────────────────────────────────────────────────
// `.trust` — flat surface (NOT glass: design uses rgba(255,255,255,.03) +
// 1px border, no gradient), 3 columns separated by hairline dividers.

function TrustStrip() {
  return (
    <View
      style={{
        marginHorizontal: 20,
        marginTop: 16,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <TrustCol top="8,400+" label="verified pros" />
      <Divider />
      <TrustCol top="100%" label={'satisfaction\nor re-clean free'} />
      <Divider />
      <TrustCol top="60 sec" label="avg. booking" />
    </View>
  );
}

function TrustCol({ top, label }: { top: string; label: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={[fontBold, { fontSize: 13, color: '#FFFFFF', letterSpacing: -0.13 }]}>
        {top}
      </Text>
      <Text
        style={[
          fontReg,
          { fontSize: 11.5, color: 'rgba(255,255,255,0.7)', marginTop: 2, lineHeight: 15 },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function Divider() {
  return (
    <View
      style={{
        width: 1,
        alignSelf: 'stretch',
        backgroundColor: 'rgba(255,255,255,0.15)',
      }}
    />
  );
}

// ── Sign-off ─────────────────────────────────────────────────────────────────
// Editorial close — riffs on the brand name. "We mop. You zop." inverts the
// usual "you do X / we do Y" pattern.

function Signoff() {
  return (
    <View style={{ marginTop: 48, paddingHorizontal: 20 }}>
      <Text
        style={[
          fontExtra,
          {
            fontSize: Math.min(58, SCREEN_W * 0.14),
            lineHeight: Math.min(60, SCREEN_W * 0.15),
            color: '#FFFFFF',
            letterSpacing: -2,
          },
        ]}
      >
        We mop.{'\n'}You zop.
      </Text>

      <Text
        style={[
          fontExtra,
          { fontSize: 22, color: '#F5A300', letterSpacing: 6, marginTop: 24 },
        ]}
      >
        ZOPMOP
      </Text>

      <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap' }}>
        {['Vetted pros', '30-min support', 'Refund if unhappy'].map((label, i, arr) => (
          <React.Fragment key={label}>
            <Text
              style={[
                fontMed,
                { fontSize: 12, color: 'rgba(255,255,255,0.55)', letterSpacing: 0.2 },
              ]}
            >
              {label}
            </Text>
            {i < arr.length - 1 && (
              <Text
                style={[
                  fontMed,
                  { fontSize: 12, color: 'rgba(255,255,255,0.25)', marginHorizontal: 8 },
                ]}
              >
                ·
              </Text>
            )}
          </React.Fragment>
        ))}
      </View>

      <Text
        style={[
          fontMed,
          {
            fontSize: 11,
            color: 'rgba(255,255,255,0.45)',
            letterSpacing: 1.2,
            marginTop: 32,
            textTransform: 'uppercase',
          },
        ]}
      >
        Built in Bengaluru · For homes everywhere
      </Text>
    </View>
  );
}
