import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import { getReferralStats, type ReferralStats } from '../../api/referral';

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors).
// useColors()'s dark palette is Slate (#0F172A bg / #1E293B surface / #FFC042
// accent), which would change this screen's dark look and fork the amber —
// breaking "dark pixel-identical" + "amber #F5A300 in both". useC() keeps dark
// at #0A0A0A / #F5A300 (identical) and carries the cream + amber-radial light bg,
// matching the other migrated screens (Home, Cart, ServiceComplete).

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'ReferralEarn'>;
};

type Banner = {
  tone: 'info' | 'success' | 'cap';
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  body: string;
};

function deriveBanner(stats: ReferralStats): Banner | null {
  const cap = stats.referrals_remaining === 0;
  const inc = stats.incoming;

  // Incoming referral pending — referee hasn't completed first booking yet.
  if (inc?.status === 'pending') {
    return {
      tone: 'info',
      icon: 'gift',
      title: 'Zop’s eager to send you ₹100',
      body: `You redeemed ${inc.referrer_code}. Book your first service to claim the ₹100 welcome credit.`,
    };
  }

  // Incoming referral already completed — referee already got their ₹100.
  if (inc?.status === 'completed') {
    if (cap) {
      return {
        tone: 'cap',
        icon: 'users',
        title: 'Zop’s tapped out',
        body: `You’ve already redeemed a code and maxed out your 3 outgoing invites. No more referrals available.`,
      };
    }
    return {
      tone: 'success',
      icon: 'check-circle',
      title: 'Zop says: welcome bonus claimed',
      body: `Only one code can be redeemed per account, but you can still invite up to ${stats.referrals_remaining} more ${stats.referrals_remaining === 1 ? 'friend' : 'friends'} to keep earning.`,
    };
  }

  // No incoming. Outgoing cap reached.
  if (cap) {
    return {
      tone: 'cap',
      icon: 'users',
      title: 'Zop’s tapped out',
      body: `You’ve maxed your 3 referrals — that’s the limit. No more invites available right now.`,
    };
  }

  return null;
}

export default function ReferralEarnScreen({ navigation }: Props) {
  const { token } = useAuth();
  const c = useC();
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(c, isDark), [c, isDark]);

  // Banner success accent: dark mint kept exact; light uses a readable deep green.
  const successGreen = isDark ? '#7CD992' : c.green;
  // Ink that sits on the amber CTA — theme-independent (button is amber in both).
  const onAmber = '#0A0A0A';

  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError('Please sign in to view your referral code.');
      return;
    }
    setLoading(true);
    setError(null);
    getReferralStats(token)
      .then(setStats)
      .catch((e: Error) => {
        console.warn('[referral] getReferralStats failed', e);
        setError(e?.message || 'Could not load referral info. Pull down to retry.');
      })
      .finally(() => setLoading(false));
  }, [token, reloadKey]);

  const handleCopy = async () => {
    if (!stats) return;
    await Clipboard.setStringAsync(stats.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    if (!stats) return;
    await Share.share({
      message: `Use my code ${stats.code} to get Rs 100 off your first ZopMop booking! ${stats.link}`,
    });
  };

  const banner = stats ? deriveBanner(stats) : null;
  const canShare = !!stats && stats.referrals_remaining > 0;

  return (
    <SafeAreaView style={styles.root}>
      <Bloom />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={16}>
          <Feather name="arrow-left" size={22} color={c.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Refer & Earn</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={c.amber} />
        </View>
      ) : (
        <View style={styles.body}>
          <View style={styles.rewardRow}>
            <View style={styles.rewardCard}>
              <Text style={styles.rewardAmount}>Rs 150</Text>
              <Text style={styles.rewardLabel}>you earn</Text>
            </View>
            <Feather name="plus" size={20} color={c.textMuted} />
            <View style={styles.rewardCard}>
              <Text style={styles.rewardAmount}>Rs 100</Text>
              <Text style={styles.rewardLabel}>friend earns</Text>
            </View>
          </View>
          <Text style={styles.rewardSub}>
            Both credited after your friend completes their first booking.
          </Text>

          {error && !stats && (
            <View style={styles.errorCard}>
              <Feather name="alert-circle" size={18} color={c.amber} />
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity onPress={() => setReloadKey((k) => k + 1)} style={styles.retryBtn}>
                <Text style={styles.retryLabel}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}

          {banner && (
            <View
              style={[
                styles.banner,
                banner.tone === 'success' && { borderLeftColor: successGreen },
                banner.tone === 'cap' && styles.bannerCap,
              ]}
            >
              <Feather
                name={banner.icon}
                size={20}
                color={
                  banner.tone === 'success'
                    ? successGreen
                    : banner.tone === 'cap'
                      ? c.textMuted
                      : c.amber
                }
              />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.bannerTitle}>{banner.title}</Text>
                <Text style={styles.bannerBody}>{banner.body}</Text>
              </View>
            </View>
          )}

          {stats && (
            <>
              <View style={styles.codeRow}>
                <Text style={styles.codeText}>{stats.code}</Text>
                <TouchableOpacity onPress={handleCopy} style={styles.copyBtn}>
                  <Feather name={copied ? 'check' : 'copy'} size={16} color={c.amber} />
                  <Text style={styles.copyLabel}>{copied ? 'Copied' : 'Copy'}</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.progressRow}>
                <Text style={styles.progressText}>
                  {stats.referrals_used} {stats.referrals_used === 1 ? 'referral' : 'referrals'} used
                </Text>
                {stats.total_earned_paise > 0 && (
                  <Text style={styles.progressText}>
                    Rs {stats.total_earned_paise / 100} earned
                  </Text>
                )}
              </View>

              <TouchableOpacity
                style={[styles.shareBtn, !canShare && styles.shareBtnDisabled]}
                onPress={handleShare}
                disabled={!canShare}
              >
                <Feather
                  name="share-2"
                  size={18}
                  color={canShare ? onAmber : c.textMuted}
                />
                <Text style={[
                  styles.shareBtnText,
                  !canShare && styles.shareBtnTextDisabled,
                ]}>
                  {canShare ? 'Share Invite' : 'Referral limit reached'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

function makeStyles(c: ScreenColors, isDark: boolean) {
  // Raised surface (#141416) has no useC equivalent → documented literal in
  // dark (keeps it identical); white card in light. Light cards get a subtle
  // border + soft shadow so they read on the cream bg (dark stays borderless).
  const surface = isDark ? '#141416' : c.white;
  const lightCard = isDark
    ? null
    : {
        borderWidth: 1,
        borderColor: c.glassBorder,
        shadowColor: '#000',
        shadowOpacity: 0.04,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 1,
      };

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.glassBorder,
    },
    title: { color: c.text, fontSize: 17, fontWeight: '600' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, padding: 24 },
    rewardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
    },
    rewardCard: { alignItems: 'center', marginHorizontal: 16 },
    // Hero amount stays bright brand amber in both (bold 32px reads on cream).
    rewardAmount: { color: c.amber, fontSize: 32, fontWeight: '700' },
    rewardLabel: { color: c.textSecondary, fontSize: 13, marginTop: 4 },
    rewardSub: { color: c.textMuted, fontSize: 13, textAlign: 'center', marginBottom: 24 },
    banner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: surface,
      borderLeftWidth: 3,
      borderLeftColor: c.amber,
      borderRadius: 12,
      padding: 14,
      marginBottom: 20,
      ...(lightCard || {}),
    },
    bannerCap: { borderLeftColor: c.textMuted },
    bannerTitle: { color: c.text, fontSize: 14, fontWeight: '600', marginBottom: 4 },
    bannerBody: { color: c.textSecondary, fontSize: 13, lineHeight: 18 },
    codeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: surface,
      borderRadius: 12,
      paddingHorizontal: 20,
      paddingVertical: 16,
      marginBottom: 16,
      ...(lightCard || {}),
    },
    codeText: { color: c.text, fontSize: 22, fontWeight: '700', letterSpacing: 2 },
    copyBtn: { flexDirection: 'row', alignItems: 'center' },
    copyLabel: { color: c.amber, fontSize: 13, fontWeight: '600', marginLeft: 6 },
    progressRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 24,
    },
    progressText: { color: c.textSecondary, fontSize: 13 },
    shareBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.amber,
      borderRadius: 14,
      paddingVertical: 16,
    },
    shareBtnDisabled: { backgroundColor: surface, ...(lightCard || {}) },
    // Ink on amber CTA — same in both themes.
    shareBtnText: { color: '#0A0A0A', fontSize: 16, fontWeight: '700', marginLeft: 10 },
    shareBtnTextDisabled: { color: c.textMuted },
    errorCard: {
      backgroundColor: surface,
      borderRadius: 12,
      padding: 16,
      alignItems: 'center',
      gap: 10,
      ...(lightCard || {}),
    },
    errorText: { color: c.textSecondary, fontSize: 13, textAlign: 'center' },
    retryBtn: {
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: c.amberSoft,
      borderWidth: 1,
      borderColor: c.amberLine,
    },
    retryLabel: { color: c.amber, fontSize: 14, fontWeight: '600' },
  });
}
