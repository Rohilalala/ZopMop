// WalletScreen — dark home pattern.
// Layout: Bloom backdrop → header (back + title + sub) → balance hero
// (gradient + amber glow) → quick-action rail → recent activity → why-wallet.

import React from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient as SvgRadialGradient,
  Stop,
  Rect,
} from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';

import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Nav = NativeStackNavigationProp<MainStackParamList>;

export default function WalletScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <Bloom />

      <ScrollView
        style={{ flex: 1, backgroundColor: 'transparent' }}
        contentContainerStyle={{ paddingBottom: 40 + insets.bottom }}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[0]}
      >
        <View style={[s.head, { paddingTop: insets.top + 10 }]}>
          <View style={s.headRow}>
            <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
              <Feather name="chevron-left" size={18} color="#FFFFFF" />
            </PressFx>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>Wallet</Text>
              <Text style={s.sub}>Earn credit on every booking.</Text>
            </View>
          </View>
        </View>

        <BalanceHero />

        <Text style={s.secH}>Quick actions</Text>
        <View style={s.rail}>
          <RailItem icon="plus" label="Add money" disabled />
          <RailItem icon="gift" label="Redeem code" disabled />
          <RailItem icon="share-2" label="Refer & earn" onPress={() => {}} />
        </View>

        <Text style={s.secH}>Recent activity</Text>
        <View style={s.body}>
          <GlassCard radius={20} style={s.card}>
            <View style={s.empty}>
              <View style={s.emptyIcon}>
                <Feather name="file-text" size={18} color="rgba(255,255,255,0.45)" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.emptyTitle}>No transactions yet</Text>
                <Text style={s.emptySub}>Wallet credits and refunds will land here.</Text>
              </View>
            </View>
          </GlassCard>
        </View>

        <Text style={s.secH}>Why ZopMop wallet</Text>
        <View style={s.body}>
          <GlassCard radius={20} style={s.card}>
            <Row icon="zap" title="Instant refunds" sub="Cancellations land back here within seconds." />
            <View style={s.divider} />
            <Row icon="percent" title="Cashback on UPI" sub="Earn ₹10 wallet credit on every UPI booking." />
            <View style={s.divider} />
            <Row icon="users" title="Refer friends" sub="₹100 wallet credit per friend who joins." />
          </GlassCard>
        </View>

        <View style={s.disclaim}>
          <Feather name="clock" size={12} color="rgba(255,255,255,0.4)" />
          <Text style={s.disclaimText}>
            Adding money + spend history coming soon. Refunds and referral credits are live.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function BalanceHero() {
  return (
    <View style={s.heroWrap}>
      <View style={s.hero}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Svg width="100%" height="100%">
            <Defs>
              <SvgLinearGradient id="walletBg" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0%" stopColor="#1A1A1C" />
                <Stop offset="100%" stopColor="#0D0D0F" />
              </SvgLinearGradient>
              <SvgRadialGradient id="walletGlow" cx="80%" cy="30%" rx="100%" ry="80%">
                <Stop offset="0%" stopColor="#F5A300" stopOpacity="0.4" />
                <Stop offset="50%" stopColor="#F5A300" stopOpacity="0" />
              </SvgRadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#walletBg)" />
            <Rect width="100%" height="100%" fill="url(#walletGlow)" />
          </Svg>
        </View>

        <View style={s.heroAmberLine} pointerEvents="none" />

        <View style={s.heroTop}>
          <Text style={s.heroEyebrow}>ZOPMOP · WALLET BALANCE</Text>
          <View style={s.heroBadge}>
            <Feather name="lock" size={10} color="#FFC042" />
            <Text style={s.heroBadgeText}>Secure</Text>
          </View>
        </View>

        <View style={s.heroBody}>
          <Text style={s.balanceCurrency}>₹</Text>
          <Text style={s.balanceValue}>0</Text>
          <Text style={s.balanceDecimals}>.00</Text>
        </View>

        <View style={s.heroFootRow}>
          <Feather name="info" size={11} color="rgba(255,255,255,0.45)" />
          <Text style={s.heroFoot}>Top-ups arrive once Wallet is live.</Text>
        </View>
      </View>
    </View>
  );
}

function RailItem({
  icon, label, onPress, disabled,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <PressFx
      onPress={onPress}
      disabled={disabled}
      style={[s.railItem, disabled && { opacity: 0.5 }]}
    >
      <View style={s.railBubble}>
        <Feather name={icon} size={20} color="#F5A300" />
        {disabled && (
          <View style={s.soonPip}>
            <Text style={s.soonText}>SOON</Text>
          </View>
        )}
      </View>
      <Text style={s.railLabel}>{label}</Text>
    </PressFx>
  );
}

function Row({
  icon, title, sub,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  sub: string;
}) {
  return (
    <View style={s.row}>
      <View style={s.rowIcon}>
        <Feather name={icon} size={17} color="#F5A300" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{title}</Text>
        <Text style={s.rowSub}>{sub}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },

  // Sticky head
  head: {
    backgroundColor: '#0A0A0A',
    paddingHorizontal: H_PAD,
    paddingBottom: 14,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
  },
  title: {
    ...fontExtra,
    fontSize: 24, color: '#FFFFFF',
    letterSpacing: -0.6, lineHeight: 28,
  },
  sub: {
    ...fontMed,
    fontSize: 12, color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },

  // Section header
  secH: {
    ...fontBold,
    fontSize: 11,
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    paddingHorizontal: H_PAD + 4,
    paddingTop: 22,
    paddingBottom: 10,
  },

  body: { paddingHorizontal: H_PAD },
  card: { padding: 14 },

  // Hero
  heroWrap: { paddingHorizontal: H_PAD, paddingTop: 6 },
  hero: {
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.4, shadowRadius: 30, shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  heroAmberLine: {
    position: 'absolute', bottom: 0, left: '20%', right: '20%', height: 1,
    backgroundColor: 'rgba(245,163,0,0.4)',
  },
  heroTop: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 22,
  },
  heroEyebrow: {
    ...fontBold,
    fontSize: 10, letterSpacing: 1.6,
    color: 'rgba(245,163,0,0.95)',
  },
  heroBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 99,
    backgroundColor: 'rgba(245,163,0,0.18)',
  },
  heroBadgeText: {
    ...fontSemi,
    fontSize: 10,
    color: '#FFC042', letterSpacing: 0.2,
  },
  heroBody: {
    flexDirection: 'row', alignItems: 'baseline', marginBottom: 14,
  },
  balanceCurrency: {
    ...fontSemi,
    fontSize: 22,
    color: 'rgba(255,255,255,0.65)', letterSpacing: -0.4,
    marginRight: 4,
  },
  balanceValue: {
    ...fontExtra,
    fontSize: 44,
    color: '#FFFFFF', letterSpacing: -1.2,
    lineHeight: 46,
  },
  balanceDecimals: {
    ...fontSemi,
    fontSize: 22,
    color: 'rgba(255,255,255,0.45)', letterSpacing: -0.4,
  },
  heroFootRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroFoot: {
    ...fontMed,
    fontSize: 11, color: 'rgba(255,255,255,0.55)',
  },

  // Rail
  rail: {
    flexDirection: 'row',
    paddingHorizontal: H_PAD - 6, paddingTop: 4,
    gap: 6,
  },
  railItem: {
    flex: 1, alignItems: 'center',
    paddingVertical: 6, paddingHorizontal: 4,
    borderRadius: 14, gap: 6,
  },
  railBubble: {
    width: 54, height: 54, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.07)',
    position: 'relative',
  },
  soonPip: {
    position: 'absolute', top: -4, right: -8,
    paddingVertical: 2, paddingHorizontal: 5, borderRadius: 99,
    backgroundColor: '#F5A300',
    borderWidth: 2, borderColor: '#0A0A0A',
  },
  soonText: {
    ...fontExtra,
    fontSize: 7, color: '#0D0D0F', letterSpacing: 0.5,
  },
  railLabel: {
    ...fontSemi,
    fontSize: 11, color: 'rgba(255,255,255,0.85)',
  },

  // Empty transactions
  empty: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  emptyIcon: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  emptyTitle: {
    ...fontBold,
    fontSize: 13.5, color: '#FFFFFF', letterSpacing: -0.1,
  },
  emptySub: {
    ...fontMed,
    fontSize: 11.5, color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },

  // Why row
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  rowIcon: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.12)',
  },
  rowTitle: {
    ...fontBold,
    fontSize: 13, color: '#FFFFFF', letterSpacing: -0.1,
  },
  rowSub: {
    ...fontMed,
    fontSize: 11.5, color: 'rgba(255,255,255,0.55)',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginVertical: 6,
  },

  disclaim: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: H_PAD + 4, paddingTop: 22,
  },
  disclaimText: {
    flex: 1,
    ...fontMed,
    fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 16,
  },
});
