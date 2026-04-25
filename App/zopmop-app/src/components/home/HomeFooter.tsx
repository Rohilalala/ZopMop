import React, { useState } from 'react';
import { View, Text, type TextStyle, Dimensions } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { PressFx } from '../ui/PressFx';

const { width: SCREEN_W } = Dimensions.get('window');

const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontMed: TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

// ── Public ───────────────────────────────────────────────────────────────────

export function HomeFooter() {
  return (
    <View style={{ marginTop: 36 }}>
      <FaqList />
      <TrustPill />
      <TrustGrid />
      <Signoff />
    </View>
  );
}

// ── FAQs (accordion) ─────────────────────────────────────────────────────────

const FAQS = [
  {
    q: 'Will I get a refund if I cancel?',
    a: 'Yes — cancel up to 30 minutes before the scheduled time for a full refund. Late cancellations may carry a small fee to compensate the assigned pro.',
  },
  {
    q: 'What if there is a service issue?',
    a: 'Reach out from Help & Support inside the app. We respond within 30 minutes and re-do or refund any service that misses the mark.',
  },
  {
    q: 'How are the pros vetted?',
    a: 'Every ZopMop pro completes Digital KYC, an in-person background check and 3 days of paid training before serving a single home.',
  },
];

function FaqList() {
  return (
    <View style={{ paddingHorizontal: 20, gap: 10 }}>
      {FAQS.map((f) => (
        <FaqItem key={f.q} q={f.q} a={f.a} />
      ))}
    </View>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  const rot = useSharedValue(0);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rot.value}deg` }],
  }));

  return (
    <PressFx
      onPress={() => {
        const next = !open;
        setOpen(next);
        rot.value = withTiming(next ? 45 : 0, { duration: 220 });
      }}
      scale={0.99}
      style={{
        backgroundColor: '#F1F5F9',
        borderRadius: 18,
        paddingHorizontal: 18,
        paddingVertical: 18,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text
          style={[fontSemi, { fontSize: 15, color: '#0F172A', flex: 1, paddingRight: 12 }]}
          numberOfLines={2}
        >
          {q}
        </Text>
        <Animated.View style={iconStyle}>
          <Feather name="plus" size={22} color="#0F172A" />
        </Animated.View>
      </View>
      {open && (
        <Animated.Text
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(120)}
          style={[
            fontReg,
            { fontSize: 14, color: '#475569', marginTop: 12, lineHeight: 22 },
          ]}
        >
          {a}
        </Animated.Text>
      )}
    </PressFx>
  );
}

// ── Trust pill (3-col) ───────────────────────────────────────────────────────

function TrustPill() {
  const items = [
    { icon: 'shield' as const, label: 'Verified' },
    { icon: 'award' as const, label: 'Trained' },
    { icon: 'clock' as const, label: 'Reliable' },
  ];
  return (
    <View
      style={{
        marginTop: 24,
        marginHorizontal: 20,
        backgroundColor: '#F1F5F9',
        borderRadius: 22,
        paddingHorizontal: 16,
        paddingVertical: 18,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      {items.map((it, i) => (
        <React.Fragment key={it.label}>
          <View style={{ flex: 1, alignItems: 'center', gap: 8 }}>
            <Feather name={it.icon} size={26} color="#475569" />
            <Text style={[fontSemi, { fontSize: 13, color: '#475569' }]}>{it.label}</Text>
          </View>
          {i < items.length - 1 && (
            <View style={{ width: 1, height: 36, backgroundColor: '#CBD5E1' }} />
          )}
        </React.Fragment>
      ))}
    </View>
  );
}

// ── 2x2 trust grid ───────────────────────────────────────────────────────────

function TrustGrid() {
  const items: { icon: React.ComponentProps<typeof Feather>['name']; title: string }[] = [
    { icon: 'user-check', title: 'Digital KYC\ncompleted' },
    { icon: 'file-text', title: 'Thorough background\nchecks' },
    { icon: 'users', title: '3-day professional\ntraining' },
    { icon: 'star', title: 'Top-rated\nexperts' },
  ];

  return (
    <View style={{ marginTop: 40, paddingHorizontal: 20 }}>
      <Text
        style={[
          fontExtra,
          { fontSize: 26, color: '#0F172A', letterSpacing: -0.4 },
        ]}
      >
        Verified. Trained.{'\n'}Top-rated.
      </Text>

      <View
        style={{
          marginTop: 24,
          flexDirection: 'row',
          flexWrap: 'wrap',
          borderTopWidth: 1,
          borderLeftWidth: 1,
          borderColor: '#E5E7EB',
          borderRadius: 18,
          overflow: 'hidden',
        }}
      >
        {items.map((it, i) => (
          <View
            key={i}
            style={{
              width: '50%',
              borderRightWidth: 1,
              borderBottomWidth: 1,
              borderColor: '#E5E7EB',
              padding: 22,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              minHeight: 130,
            }}
          >
            <Feather name={it.icon} size={28} color="#334155" />
            <Text
              style={[
                fontSemi,
                {
                  fontSize: 13,
                  color: '#0F172A',
                  textAlign: 'center',
                  lineHeight: 18,
                },
              ]}
            >
              {it.title}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Sign-off ─────────────────────────────────────────────────────────────────
// Single editorial brand block — replaces the previous Tagline + FadedTagline
// pair so the home feed ends on one definitive ZopMop voice.

function Signoff() {
  return (
    <View style={{ marginTop: 56, paddingHorizontal: 20, paddingBottom: 36 }}>
      {/* Editorial headline — leans on the "mop" pun in the brand name */}
      <Text
        style={[
          fontExtra,
          {
            fontSize: Math.min(60, SCREEN_W * 0.15),
            lineHeight: Math.min(64, SCREEN_W * 0.16),
            color: '#0F172A',
            letterSpacing: -2.4,
          },
        ]}
      >
        You live.{'\n'}We mop.
      </Text>

      {/* Wordmark */}
      <Text
        style={[
          fontExtra,
          {
            fontSize: 22,
            color: '#0F172A',
            letterSpacing: 6,
            marginTop: 28,
          },
        ]}
      >
        ZOPMOP
      </Text>

      {/* Caption row — three concrete promises, no generic "trust" filler */}
      <View
        style={{
          marginTop: 10,
          flexDirection: 'row',
          flexWrap: 'wrap',
        }}
      >
        {[
          'Vetted pros',
          '30-min support',
          'Refund if unhappy',
        ].map((label, i, arr) => (
          <React.Fragment key={label}>
            <Text style={[fontMed, { fontSize: 12, color: '#64748B', letterSpacing: 0.2 }]}>
              {label}
            </Text>
            {i < arr.length - 1 && (
              <Text style={[fontMed, { fontSize: 12, color: '#CBD5E1', marginHorizontal: 8 }]}>
                ·
              </Text>
            )}
          </React.Fragment>
        ))}
      </View>

      {/* Footer signature — concrete origin, not generic "India" claim */}
      <Text
        style={[
          fontMed,
          {
            fontSize: 11,
            color: '#94A3B8',
            letterSpacing: 1.2,
            marginTop: 36,
            textTransform: 'uppercase',
          },
        ]}
      >
        Built in Bengaluru · For homes everywhere
      </Text>
    </View>
  );
}
