import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { useColors } from '../../context/ThemeContext';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../../theme';
import { lightColors } from '../../theme/colors';
import DebtCapWarningBanner from '../../components/DebtCapWarningBanner';
import SettlementModal from '../../components/SettlementModal';
import type { SimplifiedDebt, MemberBalance } from '../../api/roomies';

type C = typeof lightColors;
type Props = NativeStackScreenProps<MainStackParamList, 'ManageHousehold'>;

function createStyles(c: C) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 16,
      gap: 4,
    },
    backBtn: { padding: 4, marginLeft: -4 },
    headerTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize['2xl'],
      color: c.text,
      letterSpacing: -0.5,
      flex: 1,
    },
    tabRow: {
      flexDirection: 'row',
      marginHorizontal: Spacing.base,
      borderRadius: Radius.lg,
      backgroundColor: c.surface,
      padding: 4,
      marginBottom: Spacing.md,
    },
    tab: {
      flex: 1,
      paddingVertical: Spacing.sm,
      alignItems: 'center',
      borderRadius: Radius.md,
    },
    tabActive: { backgroundColor: c.white, ...Shadow.sm },
    tabText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.textSecondary,
    },
    tabTextActive: { color: c.primary },
    content: { flex: 1 },
    // Vault tab
    totalCard: {
      marginHorizontal: Spacing.base,
      marginBottom: Spacing.md,
      backgroundColor: c.primary,
      borderRadius: Radius.xl,
      padding: Spacing.base,
    },
    totalLabel: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: 'rgba(255,255,255,0.75)',
      marginBottom: 4,
    },
    totalAmount: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize['4xl'],
      color: '#FFFFFF',
      marginBottom: Spacing.md,
    },
    addBalanceBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      backgroundColor: 'rgba(255,255,255,0.2)',
      borderRadius: Radius.lg,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    addBalanceBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: '#FFF',
    },
    memberCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.white,
      marginHorizontal: Spacing.base,
      marginBottom: Spacing.sm,
      borderRadius: Radius.xl,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      ...Shadow.sm,
    },
    memberAvatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: Spacing.md,
    },
    memberAvatarText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: c.primary,
    },
    memberName: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.text,
      flex: 1,
    },
    memberBalance: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: c.primary,
    },
    // Ledger tab
    debtCard: {
      marginHorizontal: Spacing.base,
      marginBottom: Spacing.sm,
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      ...Shadow.sm,
    },
    debtRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: Spacing.sm,
    },
    debtText: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      flex: 1,
    },
    debtUser: {
      fontFamily: FontFamily.semibold,
      color: c.text,
    },
    debtAmount: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.lg,
      color: c.danger,
    },
    settleBtn: {
      backgroundColor: c.primaryBg,
      borderRadius: Radius.md,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      alignItems: 'center',
    },
    settleBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.primary,
    },
    emptyWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: Spacing['3xl'],
    },
    emptyText: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.base,
      color: c.textMuted,
      textAlign: 'center',
    },
  });
}

export default function ManageHouseholdScreen({ route }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
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

  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [activeTab, setActiveTab] = useState<'vault' | 'ledger'>('vault');
  const [refreshing, setRefreshing] = useState(false);
  const [settlementDebt, setSettlementDebt] = useState<SimplifiedDebt | null>(null);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshVault(), refreshLedger()]);
    setRefreshing(false);
  };

  const handleAddBalance = () => {
    if (!user || !myGroup) return;
    const myMember = myGroup.members.find(m => m.user_id === user.id);
    if (!myMember) return;
    // Top-up ₹500 (50000 units) as a demo amount — replace with an input modal as needed.
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
            <Text style={s.debtUser}>{isMyDebt ? 'You' : item.from.slice(0, 8)}</Text>
            {' owes '}
            <Text style={s.debtUser}>{item.to === user?.id ? 'you' : item.to.slice(0, 8)}</Text>
          </Text>
          <Text style={s.debtAmount}>₹{(item.amount / 100).toFixed(0)}</Text>
        </View>
        {isMyDebt && (
          <Pressable style={s.settleBtn} onPress={() => setSettlementDebt(item)}>
            <Text style={s.settleBtnText}>Settle</Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{myGroup?.group.name ?? 'Manage Household'}</Text>
      </View>

      {debtCapWarning && <DebtCapWarningBanner onDismiss={dismissDebtCapWarning} />}

      {/* Tab switcher */}
      <View style={s.tabRow}>
        <Pressable style={[s.tab, activeTab === 'vault' && s.tabActive]} onPress={() => setActiveTab('vault')}>
          <Text style={[s.tabText, activeTab === 'vault' && s.tabTextActive]}>Vault</Text>
        </Pressable>
        <Pressable style={[s.tab, activeTab === 'ledger' && s.tabActive]} onPress={() => setActiveTab('ledger')}>
          <Text style={[s.tabText, activeTab === 'ledger' && s.tabTextActive]}>Ledger</Text>
        </Pressable>
      </View>

      {loading && !refreshing ? (
        <ActivityIndicator style={{ marginTop: Spacing.xl }} color={c.primary} />
      ) : activeTab === 'vault' ? (
        <FlatList
          style={s.content}
          data={vault?.members ?? []}
          keyExtractor={item => item.user_id}
          renderItem={renderMember}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          ListHeaderComponent={
            vault ? (
              <View style={s.totalCard}>
                <Text style={s.totalLabel}>Total Household Balance</Text>
                <Text style={s.totalAmount}>₹{(vault.total_balance / 100).toFixed(0)}</Text>
                <TouchableOpacity style={s.addBalanceBtn} onPress={handleAddBalance} activeOpacity={0.7}>
                  <Ionicons name="add" size={14} color="#FFF" />
                  <Text style={s.addBalanceBtnText}>Add Balance</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>No members yet</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: Spacing['2xl'] }}
        />
      ) : (
        <FlatList
          style={s.content}
          data={ledger}
          keyExtractor={(item, idx) => `${item.from}-${item.to}-${idx}`}
          renderItem={renderDebt}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>All settled up!</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: Spacing['2xl'] }}
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
    </SafeAreaView>
  );
}
