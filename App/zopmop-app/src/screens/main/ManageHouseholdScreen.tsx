// ManageHouseholdScreen — dark home pattern.
// Two-tab pane: Vault (total balance + per-member balances) and Ledger
// (simplified inter-member debts with settle CTAs).

import React, { useState } from 'react';
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
  const { isDark } = useTheme();
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
            <Feather name="chevron-left" size={18} color="#FFFFFF" />
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
              tintColor="#F5A300"
            />
          }
          ListHeaderComponent={
            vault ? (
              <GlassCard radius={22} hero style={s.totalCard}>
                <Text style={s.totalLabel}>Total household balance</Text>
                <Text style={s.totalAmount}>₹{(vault.total_balance / 100).toFixed(0)}</Text>
                <PressFx style={s.addBalanceBtn} onPress={handleAddBalance}>
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
              tintColor="#F5A300"
            />
          }
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Feather name="check-circle" size={28} color="rgba(34,197,94,0.55)" />
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

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },

  head: { paddingHorizontal: H_PAD, paddingBottom: 14 },
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

  // Tab switcher
  tabRow: {
    flexDirection: 'row',
    marginHorizontal: H_PAD,
    marginTop: 6,
    marginBottom: 14,
    padding: 4,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.07)',
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
    color: 'rgba(255,255,255,0.55)',
  },
  tabTextActive: { color: '#F5A300' },

  content: { flex: 1 },

  // Vault total hero
  totalCard: {
    padding: 18,
    marginBottom: 14,
  },
  totalLabel: {
    ...fontBold,
    fontSize: 10,
    color: 'rgba(255,255,255,0.55)',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  totalAmount: {
    ...fontExtra,
    fontSize: 36,
    color: '#FFFFFF',
    letterSpacing: -1,
    marginBottom: 14,
  },
  addBalanceBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F5A300',
    borderRadius: 99,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  addBalanceBtnText: {
    ...fontBold,
    fontSize: 12.5,
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
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.07)',
    marginBottom: 8,
  },
  memberAvatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(245,163,0,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarText: {
    ...fontBold,
    fontSize: 13,
    color: '#F5A300',
  },
  memberName: {
    ...fontSemi,
    fontSize: 14,
    color: '#FFFFFF',
    flex: 1,
  },
  memberBalance: {
    ...fontBold,
    fontSize: 15,
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },

  // Ledger
  debtCard: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.07)',
    marginBottom: 8,
  },
  debtRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  debtText: {
    ...fontMed,
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
    flex: 1,
  },
  debtUser: {
    ...fontSemi,
    color: '#FFFFFF',
  },
  debtAmount: {
    ...fontExtra,
    fontSize: 16,
    color: '#EF4444',
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
    color: '#F5A300',
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
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
  },
});
