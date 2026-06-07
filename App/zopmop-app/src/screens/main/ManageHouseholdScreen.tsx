// ManageHouseholdScreen — dark home pattern.
// Two-tab pane: Vault (total balance + per-member balances) and Ledger
// (simplified inter-member debts with settle CTAs).

import React, { useMemo, useState } from 'react';
import {
  
  FlatList,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { useRoomies } from '../../context/RoomiesContext';
import DebtCapWarningBanner from '../../components/DebtCapWarningBanner';
import SettlementModal from '../../components/SettlementModal';
import type { SimplifiedDebt, MemberBalance } from '../../api/roomies';

import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Props = NativeStackScreenProps<MainStackParamList, 'ManageHousehold'>;

export default function ManageHouseholdScreen({ route }: Props) {
  const c = useC();
  const { isDark } = useTheme();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const insets = useSafeAreaInsets();
  const { groupId } = route.params;
  const { user } = useAuth();
  const {
    myGroup,
    vault,
    ledger,
    loading,
    debtCapWarning,
    refreshVault,
    refreshLedger,
    topUpPrepaid,
    dismissDebtCapWarning,
  } = useRoomies();

  const [activeTab, setActiveTab] = useState<'vault' | 'ledger'>('vault');
  const [refreshing, setRefreshing] = useState(false);
  const [settlementDebt, setSettlementDebt] = useState<SimplifiedDebt | null>(null);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshVault(), refreshLedger()]);
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddBalance = () => {
    if (!user || !myGroup) return;
    const myMember = myGroup.members.find((m) => m.user_id === user.id);
    if (!myMember) return;
    topUpPrepaid(myMember.id, groupId, 50_000).then(refreshVault);
  };

  const renderMember = ({ item }: { item: MemberBalance }) => (
    <View style={s.memberCard}>
      <View style={s.memberAvatar}>
        <Text style={s.memberAvatarText}>{item.user_id.slice(0, 2).toUpperCase()}</Text>
      </View>
      <Text style={s.memberName} numberOfLines={1}>
        {item.user_id === user?.id ? 'You' : item.user_id.slice(0, 8)}
      </Text>
      <Text style={s.memberBalance}>₹{(item.balance / 100).toFixed(0)}</Text>
    </View>
  );

  const renderDebt = ({ item }: { item: SimplifiedDebt }) => {
    const isMyDebt = item.from === user?.id;
    return (
      <View style={s.debtCard}>
        <View style={s.debtRow}>
          <Text style={s.debtText}>
            <Text style={s.debtUser}>
              {isMyDebt ? 'You' : item.from.slice(0, 8)}
            </Text>
            {' owes '}
            <Text style={s.debtUser}>
              {item.to === user?.id ? 'you' : item.to.slice(0, 8)}
            </Text>
          </Text>
          <Text style={s.debtAmount}>₹{(item.amount / 100).toFixed(0)}</Text>
        </View>
        {isMyDebt && (
          <PressFx style={s.settleBtn} onPress={() => setSettlementDebt(item)}>
            <Text style={s.settleBtnText}>Settle</Text>
          </PressFx>
        )}
      </View>
    );
  };

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <View style={[s.head, { paddingTop: insets.top + 10 }]}>
        <View style={s.headRow}>
          <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
            <Feather name="chevron-left" size={18} color={c.text} />
          </PressFx>
          <View style={{ flex: 1 }}>
            <Text style={s.title} numberOfLines={1}>
              {myGroup?.group.name ?? 'Household'}
            </Text>
            <Text style={s.sub}>Vault & ledger.</Text>
          </View>
        </View>
      </View>

      {debtCapWarning && <DebtCapWarningBanner onDismiss={dismissDebtCapWarning} />}

      <View style={s.tabRow}>
        <PressFx
          style={[s.tab, activeTab === 'vault' && s.tabActive]}
          onPress={() => setActiveTab('vault')}
        >
          <Text style={[s.tabText, activeTab === 'vault' && s.tabTextActive]}>Vault</Text>
        </PressFx>
        <PressFx
          style={[s.tab, activeTab === 'ledger' && s.tabActive]}
          onPress={() => setActiveTab('ledger')}
        >
          <Text style={[s.tabText, activeTab === 'ledger' && s.tabTextActive]}>Ledger</Text>
        </PressFx>
      </View>

      {loading && !refreshing ? (
        <LoadingSkeleton variant="list" rows={4} />
      ) : activeTab === 'vault' ? (
        <FlatList
          style={s.content}
          data={vault?.members ?? []}
          keyExtractor={(item) => item.user_id}
          renderItem={renderMember}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.amber}
            />
          }
          ListHeaderComponent={
            vault ? (
              <GlassCard radius={22} hero style={s.totalCard}>
                <Text style={s.totalLabel}>Total household balance</Text>
                <Text style={s.totalAmount}>₹{(vault.total_balance / 100).toFixed(0)}</Text>
                <PressFx style={s.addBalanceBtn} onPress={handleAddBalance}>
                  {/* Ink on amber — same in both themes. */}
                  <Feather name="plus" size={13} color="#0A0A0A" />
                  <Text style={s.addBalanceBtnText}>Add balance</Text>
                </PressFx>
              </GlassCard>
            ) : null
          }
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>No members yet</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: 40 + insets.bottom, paddingHorizontal: H_PAD }}
        />
      ) : (
        <FlatList
          style={s.content}
          data={ledger}
          keyExtractor={(item, idx) => `${item.from}-${item.to}-${idx}`}
          renderItem={renderDebt}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.amber}
            />
          }
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Feather name="check-circle" size={28} color={isDark ? 'rgba(34,197,94,0.55)' : c.green} />
              <Text style={[s.emptyText, { marginTop: 10 }]}>All settled up</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: 40 + insets.bottom, paddingHorizontal: H_PAD }}
        />
      )}

      {settlementDebt && user && (
        <SettlementModal
          visible={!!settlementDebt}
          debtID={`${settlementDebt.from}-${settlementDebt.to}`}
          debtorUserID={user.id}
          groupID={groupId}
          amountOwed={settlementDebt.amount}
          onClose={() => setSettlementDebt(null)}
        />
      )}
    </View>
  );
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors
// slate). useColors()'s dark palette is slate (#0F172A bg / slate surface),
// which would change this screen's dark look and fork the amber — breaking
// "dark pixel-identical" + "amber #F5A300 in both". useC() keeps dark at
// #0A0A0A + amber (identical) and adds the cream + amber light bg, matching the
// other migrated screens (Wallet, ReferralEarn).
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Danger amount (#EF4444) → readable deep red in light; dark kept exact.
  const danger = isDark ? '#EF4444' : c.danger;
  // Glass cards read on dark as-is; on cream they get a subtle border + soft
  // shadow so they don't disappear into the bg (dark stays shadowless).
  const lightCard = isDark
    ? null
    : {
        shadowColor: '#000',
        shadowOpacity: 0.04,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 1,
      };

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },

    head: { paddingHorizontal: H_PAD, paddingBottom: 14 },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    iconBtn: {
      width: 36, height: 36, borderRadius: 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.glassHi,
      borderWidth: 0.5, borderColor: c.glassBorderHi,
    },
    title: {
      ...fontExtra,
      fontSize: 24, color: c.text,
      letterSpacing: -0.6, lineHeight: 28,
    },
    sub: {
      ...fontMed,
      fontSize: 12, color: c.textMuted,
      marginTop: 2,
    },

    // Tab switcher
    tabRow: {
      flexDirection: 'row',
      marginHorizontal: H_PAD,
      marginTop: 6,
      marginBottom: 14,
      padding: 4,
      borderRadius: 14,
      backgroundColor: c.glass,
      borderWidth: 0.5,
      borderColor: c.glassBorder,
    },
    tab: {
      flex: 1,
      paddingVertical: 8,
      alignItems: 'center',
      borderRadius: 10,
    },
    tabActive: {
      backgroundColor: 'rgba(245,163,0,0.16)',
      borderWidth: 0.5,
      borderColor: 'rgba(245,163,0,0.32)',
    },
    tabText: {
      ...fontSemi,
      fontSize: 12.5,
      color: c.textSecondary,
    },
    tabTextActive: { color: c.amber },

    content: { flex: 1 },

    // Vault total hero
    totalCard: {
      padding: 18,
      marginBottom: 14,
    },
    totalLabel: {
      ...fontBold,
      fontSize: 10,
      color: c.textSecondary,
      letterSpacing: 1.3,
      textTransform: 'uppercase',
      marginBottom: 8,
    },
    totalAmount: {
      ...fontExtra,
      fontSize: 36,
      color: c.text,
      letterSpacing: -1,
      marginBottom: 14,
    },
    addBalanceBtn: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.amber,
      borderRadius: 99,
      paddingVertical: 7,
      paddingHorizontal: 12,
    },
    addBalanceBtnText: {
      ...fontBold,
      fontSize: 12.5,
      // Ink on amber — same in both themes.
      color: '#0A0A0A',
      letterSpacing: 0.1,
    },

    memberCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 16,
      backgroundColor: c.glass,
      borderWidth: 0.5,
      borderColor: c.glassBorder,
      marginBottom: 8,
      ...(lightCard || {}),
    },
    memberAvatar: {
      width: 38, height: 38, borderRadius: 19,
      backgroundColor: c.amberSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    memberAvatarText: {
      ...fontBold,
      fontSize: 13,
      color: c.amber,
    },
    memberName: {
      ...fontSemi,
      fontSize: 14,
      color: c.text,
      flex: 1,
    },
    memberBalance: {
      ...fontBold,
      fontSize: 15,
      color: c.text,
      letterSpacing: -0.2,
    },

    // Ledger
    debtCard: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 16,
      backgroundColor: c.glass,
      borderWidth: 0.5,
      borderColor: c.glassBorder,
      marginBottom: 8,
      ...(lightCard || {}),
    },
    debtRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    debtText: {
      ...fontMed,
      fontSize: 13,
      color: c.textSecondary,
      flex: 1,
    },
    debtUser: {
      ...fontSemi,
      color: c.text,
    },
    debtAmount: {
      ...fontExtra,
      fontSize: 16,
      color: danger,
      letterSpacing: -0.3,
    },
    settleBtn: {
      marginTop: 10,
      backgroundColor: 'rgba(245,163,0,0.16)',
      borderRadius: 10,
      paddingVertical: 8,
      alignItems: 'center',
      borderWidth: 0.5,
      borderColor: 'rgba(245,163,0,0.3)',
    },
    settleBtnText: {
      ...fontBold,
      fontSize: 12.5,
      color: c.amber,
    },

    emptyWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 80,
    },
    emptyText: {
      ...fontMed,
      fontSize: 13.5,
      color: c.textMuted,
      textAlign: 'center',
    },
  });
}
