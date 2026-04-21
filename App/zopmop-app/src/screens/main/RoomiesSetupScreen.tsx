import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { useColors } from '../../context/ThemeContext';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../../theme';
import { lightColors } from '../../theme/colors';
import { listAddresses } from '../../api/addresses';
import type { ApiAddress } from '../../api/addresses';
import { createGroup } from '../../api/roomies';

type C = typeof lightColors;

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
    },
    body: { flex: 1, paddingHorizontal: Spacing.base },
    sectionLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginBottom: Spacing.sm,
      marginTop: Spacing.xl,
    },
    optionCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      padding: Spacing.base,
      marginBottom: Spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
      ...Shadow.sm,
    },
    optionIcon: {
      width: 48,
      height: 48,
      borderRadius: Radius.full,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: Spacing.md,
    },
    optionTitle: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.text,
      marginBottom: 2,
    },
    optionSub: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textSecondary,
    },
    optionChevron: { marginLeft: 'auto' },
    // Active group card
    groupCard: {
      backgroundColor: c.primary,
      borderRadius: Radius.xl,
      padding: Spacing.base,
      marginTop: Spacing.xl,
      ...Shadow.sm,
    },
    groupCardLabel: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: 'rgba(255,255,255,0.75)',
      marginBottom: 4,
    },
    groupCardName: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.xl,
      color: '#FFF',
      marginBottom: Spacing.sm,
    },
    groupCardRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    groupCardChip: {
      backgroundColor: 'rgba(255,255,255,0.2)',
      borderRadius: Radius.full,
      paddingVertical: 4,
      paddingHorizontal: 10,
    },
    groupCardChipText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.xs,
      color: '#FFF',
    },
    codeBlock: {
      marginTop: Spacing.md,
      backgroundColor: 'rgba(0,0,0,0.15)',
      borderRadius: Radius.lg,
      padding: Spacing.md,
      alignItems: 'center',
    },
    codeLabel: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.xs,
      color: 'rgba(255,255,255,0.7)',
      marginBottom: 4,
    },
    codeValue: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize['2xl'],
      color: '#FFF',
      letterSpacing: 6,
    },
    dangerRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.xl },
    dangerBtn: {
      flex: 1,
      borderRadius: Radius.lg,
      paddingVertical: Spacing.md,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.danger,
    },
    dangerBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.danger,
    },
    // Address picker modal
    modal: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: c.white,
      borderTopLeftRadius: Radius['2xl'],
      borderTopRightRadius: Radius['2xl'],
      paddingTop: Spacing.md,
      paddingBottom: Spacing['3xl'],
      maxHeight: '70%',
    },
    sheetHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      alignSelf: 'center',
      marginBottom: Spacing.md,
    },
    sheetTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.lg,
      color: c.text,
      paddingHorizontal: Spacing.base,
      marginBottom: Spacing.md,
    },
    addrItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: Spacing.md,
    },
    addrIcon: {
      width: 40,
      height: 40,
      borderRadius: Radius.full,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addrTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.text },
    addrSub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    emptyAddr: { paddingVertical: Spacing['3xl'], alignItems: 'center' },
    emptyAddrText: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textMuted },
  });
}

export default function RoomiesSetupScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token, user } = useAuth();
  const { myGroup, refresh, leaveGroup, deleteGroup } = useRoomies();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [addrModalVisible, setAddrModalVisible] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);

  const loadAddresses = useCallback(async () => {
    if (!token) return;
    try {
      const data = await listAddresses(token);
      setAddresses(data);
    } catch {
      // non-fatal
    }
  }, [token]);

  useEffect(() => {
    loadAddresses();
  }, [loadAddresses]);

  const handleSelectAddress = async (addr: ApiAddress) => {
    if (!token) return;
    setAddrModalVisible(false);
    setCreatingGroup(true);
    try {
      const group = await createGroup(token, { address_id: addr.id, name: addr.title || addr.full_address });
      await refresh();
      navigation.replace('RoomiesCodeShare', {
        groupId: group.id,
        code: group.invite_code,
        groupName: group.name,
      });
    } catch (err: any) {
      Alert.alert('Could not create household', err.message ?? 'Please try again.');
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleLeave = () => {
    if (!myGroup || !user) return;
    Alert.alert(
      'Leave household?',
      'You will lose access to the shared vault and ledger.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              await leaveGroup(myGroup.group.id, user.id);
              await refresh();
            } catch (err: any) {
              Alert.alert('Error', err.message ?? 'Could not leave group');
            }
          },
        },
      ],
    );
  };

  const handleDelete = () => {
    if (!myGroup) return;
    Alert.alert(
      'Delete household?',
      'This will permanently delete the group, balances, and all debt records.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteGroup(myGroup.group.id, true);
              await refresh();
            } catch (err: any) {
              Alert.alert('Error', err.message ?? 'Could not delete group');
            }
          },
        },
      ],
    );
  };

  const isHost = myGroup?.my_role === 'host';

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Roomies</Text>
      </View>

      <View style={s.body}>
        {myGroup ? (
          // ── Active group state ──────────────────────────────────────────────
          <>
            <View style={s.groupCard}>
              <Text style={s.groupCardLabel}>Your Household</Text>
              <Text style={s.groupCardName}>{myGroup.group.name}</Text>
              <View style={s.groupCardRow}>
                <View style={s.groupCardChip}>
                  <Text style={s.groupCardChipText}>
                    {myGroup.members.length} member{myGroup.members.length !== 1 ? 's' : ''}
                  </Text>
                </View>
                <View style={s.groupCardChip}>
                  <Text style={s.groupCardChipText}>{isHost ? 'Host' : 'Member'}</Text>
                </View>
              </View>
              {isHost && (
                <View style={s.codeBlock}>
                  <Text style={s.codeLabel}>Invite Code</Text>
                  <Text style={s.codeValue}>
                    {myGroup.group.invite_code.slice(0, 3)} {myGroup.group.invite_code.slice(3)}
                  </Text>
                </View>
              )}
            </View>

            <View style={s.dangerRow}>
              <TouchableOpacity style={s.dangerBtn} onPress={handleLeave} activeOpacity={0.7}>
                <Text style={s.dangerBtnText}>Leave</Text>
              </TouchableOpacity>
              {isHost && (
                <TouchableOpacity style={s.dangerBtn} onPress={handleDelete} activeOpacity={0.7}>
                  <Text style={s.dangerBtnText}>Delete Household</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        ) : (
          // ── No group state ──────────────────────────────────────────────────
          <>
            <Text style={s.sectionLabel}>Set up Roomies</Text>

            <TouchableOpacity
              style={s.optionCard}
              activeOpacity={0.7}
              onPress={() => setAddrModalVisible(true)}
              disabled={creatingGroup}
            >
              <View style={s.optionIcon}>
                {creatingGroup ? (
                  <ActivityIndicator size="small" color={c.primary} />
                ) : (
                  <Ionicons name="home-outline" size={22} color={c.primary} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.optionTitle}>Enable for my address</Text>
                <Text style={s.optionSub}>Create a household and get an invite code</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={c.textMuted} style={s.optionChevron} />
            </TouchableOpacity>

            <TouchableOpacity
              style={s.optionCard}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('RoomiesJoin')}
            >
              <View style={s.optionIcon}>
                <Ionicons name="key-outline" size={22} color={c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.optionTitle}>Join with a code</Text>
                <Text style={s.optionSub}>Enter a 6-digit code from your housemate</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={c.textMuted} style={s.optionChevron} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Address picker bottom sheet */}
      <Modal
        visible={addrModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setAddrModalVisible(false)}
      >
        <Pressable style={s.modal} onPress={() => setAddrModalVisible(false)}>
          <Pressable style={s.sheet} onPress={e => e.stopPropagation()}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle}>Select an address</Text>
            <FlatList
              data={addresses}
              keyExtractor={item => item.id}
              renderItem={({ item }) => (
                <TouchableOpacity style={s.addrItem} onPress={() => handleSelectAddress(item)} activeOpacity={0.7}>
                  <View style={s.addrIcon}>
                    <Ionicons
                      name={item.tag === 'Home' ? 'home-outline' : item.tag === 'Work' ? 'briefcase-outline' : 'location-outline'}
                      size={18}
                      color={c.primary}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.addrTitle}>{item.title || item.tag}</Text>
                    <Text style={s.addrSub} numberOfLines={1}>{item.full_address}</Text>
                  </View>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <View style={s.emptyAddr}>
                  <Text style={s.emptyAddrText}>No saved addresses</Text>
                </View>
              }
            />
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
