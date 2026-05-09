// WalletScreen — closed-loop wallet hero + transaction history.
//
// Layout: Bloom backdrop → header → balance hero (gradient + amber glow)
// → primary "Top up" CTA → quick-action rail → recent activity list →
// why-wallet info card.
//
// Data: pulls getWalletBalance + getWalletTransactions on focus and on
// pull-to-refresh. Matches the BookingsScreen hydration pattern (memCache
// + useFocusEffect skeleton-only-on-first-load).

import React, { useCallback, useState } from 'react';
import {
  RefreshControl,
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
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';

import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { useAuth } from '../../context/AuthContext';
import {
  getWalletBalance,
  getWalletTransactions,
  type WalletTransaction,
} from '../../api/wallet';
import { showError } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import WalletTopupSheet from './WalletTopupSheet';
import { usePostHog } from 'posthog-react-native';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Nav = NativeStackNavigationProp<MainStackParamList>;

// Module-level cache so re-entering Wallet from Profile doesn't flash the
// skeleton when we already have data. Mirrors the bookingsMemCache pattern
// in BookingsScreen.
const walletMemCache: {
  balancePaise: number | null;
  transactions: WalletTransaction[] | null;
} = { balancePaise: null, transactions: null };

export default function WalletScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const posthog = usePostHog();

  const [balancePaise, setBalancePaise] = useState<number | null>(walletMemCache.balancePaise);
  const [transactions, setTransactions] = useState<WalletTransaction[]>(
    walletMemCache.transactions ?? [],
  );
  const [loading, setLoading] = useState(walletMemCache.balancePaise == null);
  const [refreshing, setRefreshing] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const [balance, txns] = await Promise.all([
        getWalletBalance(token),
        getWalletTransactions(token, { limit: 10 }),
      ]);
      setBalancePaise(balance.balance_paise);
      setTransactions(txns.transactions);
      walletMemCache.balancePaise = balance.balance_paise;
      walletMemCache.transactions = txns.transactions;
      setErrorBanner(null);
    } catch (err) {
      console.warn('[wallet] fetch failed', err);
      setErrorBanner("Couldn't load wallet. Pull to refresh.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      if (walletMemCache.balancePaise == null) setLoading(true);
      fetchAll();
    }, [fetchAll]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const handleTopupPress = useCallback(() => {
    haptics.light();
    if (!token) {
      showError('Please sign in to top up your wallet.');
      return;
    }
    posthog.capture('wallet_topup_opened', { balance_paise: balancePaise });
    setTopupOpen(true);
  }, [token, posthog, balancePaise]);

  const handleTopupSuccess = useCallback(() => {
    fetchAll();
  }, [fetchAll]);

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <Bloom />

      <ScrollView
        style={{ flex: 1, backgroundColor: 'transparent' }}
        contentContainerStyle={{ paddingBottom: 40 + insets.bottom }}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[0]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#F5A300"
            colors={['#F5A300']}
          />
        }
      >
        <View style={[s.head, { paddingTop: insets.top + 10 }]}>
          <View style={s.headRow}>
            <PressFx
              accessibilityRole="button"
              accessibilityLabel="Go back"
              onPress={() => navigation.goBack()}
              style={s.iconBtn}
            >
              <Feather name="chevron-left" size={18} color="#FFFFFF" />
            </PressFx>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>Wallet</Text>
              <Text style={s.sub}>Closed-loop credit for ZopMop bookings.</Text>
            </View>
          </View>
        </View>

        {errorBanner ? (
          <View style={s.banner}>
            <Feather name="alert-circle" size={13} color="#FF8E8E" />
            <Text style={s.bannerText}>{errorBanner}</Text>
            <PressFx onPress={fetchAll} style={s.bannerCta}>
              <Text style={s.bannerCtaText}>Retry</Text>
            </PressFx>
          </View>
        ) : null}

        <BalanceHero balancePaise={balancePaise} loading={loading} />

        <View style={[s.body, { paddingTop: 14 }]}>
          <PressFx
            accessibilityRole="button"
            accessibilityLabel="Top up wallet"
            onPress={handleTopupPress}
            style={s.topupCta}
          >
            <Feather name="plus" size={18} color="#0D0D0F" />
            <Text style={s.topupCtaText}>Top up</Text>
          </PressFx>
        </View>

        <Text style={s.secH}>Recent activity</Text>
        <View style={s.body}>
          <GlassCard radius={20} style={s.card}>
            {loading && transactions.length === 0 ? (
              <View style={{ paddingVertical: 12 }}>
                <LoadingBars />
              </View>
            ) : transactions.length === 0 ? (
              <View style={s.empty}>
                <View style={s.emptyIcon}>
                  <Feather name="file-text" size={18} color="rgba(255,255,255,0.45)" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.emptyTitle}>No transactions yet</Text>
                  <Text style={s.emptySub}>Top up to get started.</Text>
                </View>
              </View>
            ) : (
              transactions.map((t, i) => (
                <React.Fragment key={t.id}>
                  {i > 0 ? <View style={s.divider} /> : null}
                  <TxnRow t={t} />
                </React.Fragment>
              ))
            )}
          </GlassCard>
        </View>

        <Text style={s.secH}>Why ZopMop wallet</Text>
        <View style={s.body}>
          <GlassCard radius={20} style={s.card}>
            <Row icon="zap" title="Instant refunds" sub="Cancellations land back here within seconds." />
            <View style={s.divider} />
            <Row icon="lock" title="Closed-loop credit" sub="Spendable only on ZopMop bookings — no third-party charges." />
            <View style={s.divider} />
            <Row icon="users" title="Refer friends" sub="₹100 wallet credit per friend who joins." />
          </GlassCard>
        </View>
      </ScrollView>

      {token ? (
        <WalletTopupSheet
          visible={topupOpen}
          onClose={() => setTopupOpen(false)}
          onSuccess={handleTopupSuccess}
          token={token}
        />
      ) : null}
    </View>
  );
}

function BalanceHero({ balancePaise, loading }: { balancePaise: number | null; loading: boolean }) {
  const display = balancePaise == null ? null : formatRupees(balancePaise);

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
          {display ? (
            <>
              <Text style={s.balanceValue}>{display.whole}</Text>
              <Text style={s.balanceDecimals}>.{display.decimals}</Text>
            </>
          ) : (
            <Text style={s.balanceValue}>{loading ? '—' : '0'}</Text>
          )}
        </View>

        <View style={s.heroFootRow}>
          <Feather name="info" size={11} color="rgba(255,255,255,0.45)" />
          <Text style={s.heroFoot}>Use balance at checkout to skip the payment sheet.</Text>
        </View>
      </View>
    </View>
  );
}

function TxnRow({ t }: { t: WalletTransaction }) {
  const isCredit = t.amount_paise > 0;
  const sign = isCredit ? '+' : '−';
  const abs = Math.abs(t.amount_paise);
  const { whole, decimals } = formatRupees(abs);
  const label = labelForKind(t.kind);
  const icon = iconForKind(t.kind);
  const tint = isCredit ? '#F5A300' : 'rgba(255,255,255,0.85)';

  return (
    <View
      style={s.row}
      accessibilityRole="text"
      accessibilityLabel={`${isCredit ? 'Credit' : 'Debit'} of ${whole}.${decimals} rupees, ${label}`}
    >
      <View style={s.rowIcon}>
        <Feather name={icon} size={17} color="#F5A300" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{t.note || label}</Text>
        <Text style={s.rowSub}>{relativeTime(t.created_at)}</Text>
      </View>
      <Text style={[s.rowAmount, { color: tint }]}>
        {sign}₹{whole}
        <Text style={s.rowAmountDec}>.{decimals}</Text>
      </Text>
    </View>
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

function formatRupees(paise: number): { whole: string; decimals: string } {
  const rupees = Math.floor(paise / 100);
  const dec = (paise % 100).toString().padStart(2, '0');
  return { whole: rupees.toLocaleString('en-IN'), decimals: dec };
}

function labelForKind(kind: WalletTransaction['kind']): string {
  switch (kind) {
    case 'topup':         return 'Wallet topup';
    case 'spend':         return 'Booking payment';
    case 'refund_credit': return 'Refund credit';
    case 'adjustment':    return 'Adjustment';
    case 'reversal':      return 'Reversal';
  }
}

function iconForKind(kind: WalletTransaction['kind']): keyof typeof Feather.glyphMap {
  switch (kind) {
    case 'topup':         return 'plus-circle';
    case 'spend':         return 'shopping-bag';
    case 'refund_credit': return 'corner-down-left';
    case 'adjustment':    return 'tool';
    case 'reversal':      return 'rotate-ccw';
  }
}

// Relative timestamp — "now", "5m ago", "2h ago", "Yesterday", "Mar 12".
function relativeTime(rfc3339: string): string {
  const t = Date.parse(rfc3339);
  if (!Number.isFinite(t)) return '';
  const now = Date.now();
  const diffMs = now - t;
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return 'now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  const d = new Date(t);
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },

  head: {
    backgroundColor: '#0A0A0A',
    paddingHorizontal: H_PAD,
    paddingBottom: 14,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 44, height: 44, borderRadius: 22,
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

  banner: {
    marginHorizontal: H_PAD,
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255,142,142,0.09)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,142,142,0.3)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bannerText: {
    flex: 1,
    ...fontMed,
    fontSize: 12.5,
    color: '#FF8E8E',
  },
  bannerCta: { paddingVertical: 4, paddingHorizontal: 8 },
  bannerCtaText: { ...fontBold, fontSize: 12, color: '#FF8E8E' },

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

  topupCta: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    backgroundColor: '#F5A300',
    minHeight: 44,
  },
  topupCtaText: {
    ...fontExtra,
    fontSize: 15,
    color: '#0D0D0F',
    letterSpacing: -0.2,
  },

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
  rowAmount: {
    ...fontExtra,
    fontSize: 14,
    letterSpacing: -0.2,
  },
  rowAmountDec: {
    ...fontSemi,
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginVertical: 6,
  },
});
