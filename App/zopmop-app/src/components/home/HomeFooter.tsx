// HomeFooter — schedule card + trust strip. Mirrors the design's bottom-of-feed
// pair (`.schedule` + `.trust`) verbatim. No FAQ accordion, no editorial sign-off
// — those weren't in the home design and added visual noise.

import React from 'react';
import { Dimensions, View, Text, type TextStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { PressFx } from '../ui/PressFx';
import { useTheme } from '../../context/ThemeContext';
import { GlassCard } from './GlassCard';
import type { FooterData, FooterScheduleCard, FooterSignoff, FooterTrustColumn, SduiAction } from '../../sdui/types';

const { width: SCREEN_W } = Dimensions.get('window');

const fontReg:   TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

export function HomeFooter({ data, onAction }: { data: FooterData; onAction: (a: SduiAction) => void }) {
  // Trust strip ("8,400+ verified pros / 100% / 60 sec avg booking") stays
  // hidden until `data.trust` is supplied — the figures were fabricated for a
  // brand-new app and would mislead users.
  return (
    <View style={{ marginTop: 14, paddingBottom: 16 }}>
      {data.schedule_card ? <ScheduleCard card={data.schedule_card} onAction={onAction} /> : null}
      {data.trust ? <TrustStrip columns={data.trust.columns} /> : null}
      <Signoff signoff={data.signoff} />
    </View>
  );
}

// ── Schedule card ────────────────────────────────────────────────────────────
// `.schedule` — glass surface, amber-tinted icon tile, title + sub + chevron.

function ScheduleCard({ card, onAction }: { card: FooterScheduleCard; onAction: (a: SduiAction) => void }) {
  const { isDark } = useTheme();

  return (
    <PressFx
      onPress={() => onAction(card.action)}
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
            backgroundColor: isDark ? 'rgba(245,163,0,0.12)' : '#FFF2D8',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name="calendar" size={18} color="#F5A300" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[fontBold, { fontSize: 14, color: isDark ? '#FFFFFF' : '#0D0D0F' }]}>{card.title}</Text>
          <Text
            style={[
              fontReg,
              { fontSize: 11.5, color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(13,13,15,0.50)', marginTop: 2 },
            ]}
          >
            {card.subtitle}
          </Text>
        </View>
        <Text style={{ fontSize: 22, color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(13,13,15,0.35)', fontWeight: '500' }}>
          ›
        </Text>
      </GlassCard>
    </PressFx>
  );
}

// ── Trust strip ──────────────────────────────────────────────────────────────
// `.trust` — flat surface (NOT glass: design uses rgba(255,255,255,.03) +
// 1px border, no gradient), 3 columns separated by hairline dividers.

function TrustStrip({ columns }: { columns: FooterTrustColumn[] }) {
  const { isDark } = useTheme();
  return (
    <View
      style={{
        marginHorizontal: 20,
        marginTop: 16,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: 14,
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(13,13,15,0.04)',
        borderWidth: 1,
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,15,0.06)',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
      }}
    >
      {columns.map((col, i) => (
        <React.Fragment key={`${col.value}-${i}`}>
          <TrustCol top={col.value} label={col.label} isDark={isDark} />
          {i < columns.length - 1 && <Divider isDark={isDark} />}
        </React.Fragment>
      ))}
    </View>
  );
}

function TrustCol({ top, label, isDark }: { top: string; label: string; isDark: boolean }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={[fontBold, { fontSize: 13, color: isDark ? '#FFFFFF' : '#0D0D0F', letterSpacing: -0.13 }]}>
        {top}
      </Text>
      <Text
        style={[
          fontReg,
          { fontSize: 11.5, color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(13,13,15,0.65)', marginTop: 2, lineHeight: 15 },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function Divider({ isDark }: { isDark: boolean }) {
  return (
    <View
      style={{
        width: 1,
        alignSelf: 'stretch',
        backgroundColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(13,13,15,0.10)',
      }}
    />
  );
}

// ── Sign-off ─────────────────────────────────────────────────────────────────
// Editorial close — riffs on the brand name. "We mop. You zop." inverts the
// usual "you do X / we do Y" pattern.

function Signoff({ signoff }: { signoff: FooterSignoff }) {
  const { isDark } = useTheme();
  return (
    <View style={{ marginTop: 48, paddingHorizontal: 20 }}>
      <Text
        style={[
          fontExtra,
          {
            fontSize: Math.min(58, SCREEN_W * 0.14),
            lineHeight: Math.min(60, SCREEN_W * 0.15),
            color: isDark ? '#FFFFFF' : '#0D0D0F',
            letterSpacing: -2,
          },
        ]}
      >
        {signoff.lines.join('\n')}
      </Text>

      <Text
        style={[
          fontExtra,
          { fontSize: 22, color: '#F5A300', letterSpacing: 1, marginTop: 24 },
        ]}
      >
        {signoff.brand}
      </Text>

      <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap' }}>
        {signoff.badges.map((label, i, arr) => (
          <React.Fragment key={label}>
            <Text
              style={[
                fontMed,
                { fontSize: 12, color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(13,13,15,0.65)', letterSpacing: 0.2 },
              ]}
            >
              {label}
            </Text>
            {i < arr.length - 1 && (
              <Text
                style={[
                  fontMed,
                  { fontSize: 12, color: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(13,13,15,0.25)', marginHorizontal: 8 },
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
            color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(13,13,15,0.45)',
            letterSpacing: 1.2,
            marginTop: 32,
            textTransform: 'uppercase',
          },
        ]}
      >
        {signoff.tagline}
      </Text>
    </View>
  );
}
