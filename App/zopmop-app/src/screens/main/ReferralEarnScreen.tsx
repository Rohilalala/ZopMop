import React, { useEffect, useState } from 'react';
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
import { getReferralStats, type ReferralStats } from '../../api/referral';

const BG = '#0A0A0A';
const SURFACE = '#141416';
const TEXT_HI = '#FFFFFF';
const TEXT_MID = 'rgba(255,255,255,0.62)';
const TEXT_DIM = 'rgba(255,255,255,0.38)';
const AMBER = '#F5A300';
const HAIRLINE = 'rgba(255,255,255,0.08)';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'ReferralEarn'>;
};

export default function ReferralEarnScreen({ navigation }: Props) {
  const { token } = useAuth();
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) return;
    getReferralStats(token)
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

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

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={16}>
          <Feather name="arrow-left" size={22} color={TEXT_HI} />
        </TouchableOpacity>
        <Text style={styles.title}>Refer & Earn</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={AMBER} />
        </View>
      ) : (
        <View style={styles.body}>
          <View style={styles.rewardRow}>
            <View style={styles.rewardCard}>
              <Text style={styles.rewardAmount}>Rs 200</Text>
              <Text style={styles.rewardLabel}>you earn</Text>
            </View>
            <Feather name="plus" size={20} color={TEXT_DIM} />
            <View style={styles.rewardCard}>
              <Text style={styles.rewardAmount}>Rs 100</Text>
              <Text style={styles.rewardLabel}>friend earns</Text>
            </View>
          </View>
          <Text style={styles.rewardSub}>
            Both credited after your friend completes their first booking.
          </Text>

          {stats && (
            <>
              <View style={styles.codeRow}>
                <Text style={styles.codeText}>{stats.code}</Text>
                <TouchableOpacity onPress={handleCopy} style={styles.copyBtn}>
                  <Feather name={copied ? 'check' : 'copy'} size={16} color={AMBER} />
                  <Text style={styles.copyLabel}>{copied ? 'Copied' : 'Copy'}</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.progressRow}>
                <Text style={styles.progressText}>
                  {stats.referrals_used}/3 referrals used
                </Text>
                {stats.total_earned_paise > 0 && (
                  <Text style={styles.progressText}>
                    Rs {stats.total_earned_paise / 100} earned
                  </Text>
                )}
              </View>

              <TouchableOpacity
                style={[styles.shareBtn, stats.referrals_remaining === 0 && styles.shareBtnDisabled]}
                onPress={handleShare}
                disabled={stats.referrals_remaining === 0}
              >
                <Feather
                  name="share-2"
                  size={18}
                  color={stats.referrals_remaining > 0 ? '#0A0A0A' : TEXT_DIM}
                />
                <Text style={[
                  styles.shareBtnText,
                  stats.referrals_remaining === 0 && styles.shareBtnTextDisabled,
                ]}>
                  {stats.referrals_remaining > 0 ? 'Share Invite' : 'Referral limit reached'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: HAIRLINE,
  },
  title: { color: TEXT_HI, fontSize: 17, fontWeight: '600' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, padding: 24 },
  rewardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  rewardCard: { alignItems: 'center', marginHorizontal: 16 },
  rewardAmount: { color: AMBER, fontSize: 32, fontWeight: '700' },
  rewardLabel: { color: TEXT_MID, fontSize: 13, marginTop: 4 },
  rewardSub: { color: TEXT_DIM, fontSize: 13, textAlign: 'center', marginBottom: 24 },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: SURFACE,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    marginBottom: 16,
  },
  codeText: { color: TEXT_HI, fontSize: 22, fontWeight: '700', letterSpacing: 2 },
  copyBtn: { flexDirection: 'row', alignItems: 'center' },
  copyLabel: { color: AMBER, fontSize: 13, fontWeight: '600', marginLeft: 6 },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  progressText: { color: TEXT_MID, fontSize: 13 },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: AMBER,
    borderRadius: 14,
    paddingVertical: 16,
  },
  shareBtnDisabled: { backgroundColor: SURFACE },
  shareBtnText: { color: '#0A0A0A', fontSize: 16, fontWeight: '700', marginLeft: 10 },
  shareBtnTextDisabled: { color: TEXT_DIM },
});
