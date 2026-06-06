// RoomiesSetupScreen — dark home pattern.
// Two states:
//   • No group → setup options (create with my address, join with code)
//   • Active group → group hero (name, members, invite code) + leave/delete

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  
  Alert,
  FlatList,
  Modal,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { listAddresses } from '../../api/addresses';
import type { ApiAddress } from '../../api/addresses';
import { createGroup } from '../../api/roomies';
import { showError } from '../../utils/toast';

import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

export default function RoomiesSetupScreen() {
  const c = useC();
  const { isDark } = useTheme();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();
  const { myGroup, refresh, leaveGroup, deleteGroup } = useRoomies();

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

  useEffect(() => { loadAddresses(); }, [loadAddresses]);

  const handleSelectAddress = async (addr: ApiAddress) => {
    if (!token) return;
    setAddrModalVisible(false);
    setCreatingGroup(true);
    try {
      const group = await createGroup(token, {
        address_id: addr.id,
        name: addr.title || addr.full_address,
      });
      await refresh();
      navigation.replace('RoomiesCodeShare', {
        groupId: group.id,
        code: group.invite_code,
        groupName: group.name,
      });
    } catch (err: any) {
      showError(err.message ?? 'Please try again.', { title: 'Could not create household' });
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
              showError(err.message ?? 'Could not leave group');
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
      'This permanently removes the group, balances, and all debt records.',
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
              showError(err.message ?? 'Could not delete group');
            }
          },
        },
      ],
    );
  };

  const isHost = myGroup?.my_role === 'host';

  // Danger red kept exact in dark; light uses the readable token red.
  const dangerColor = isDark ? '#EF4444' : c.danger;

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
            <Text style={s.title}>Roomies</Text>
            <Text style={s.sub}>Share a household, split chores.</Text>
          </View>
        </View>
      </View>

      <View style={s.body}>
        {myGroup ? (
          <>
            <GlassCard radius={22} hero style={s.groupCard}>
              <Text style={s.groupCardLabel}>Your household</Text>
              <Text style={s.groupCardName}>{myGroup.group.name}</Text>

              <View style={s.groupCardRow}>
                <View style={s.groupCardChip}>
                  <Feather name="users" size={11} color={c.text} />
                  <Text style={s.groupCardChipText}>
                    {myGroup.members.length} member{myGroup.members.length !== 1 ? 's' : ''}
                  </Text>
                </View>
                <View style={s.groupCardChip}>
                  <Feather
                    name={isHost ? 'star' : 'user'}
                    size={11}
                    color={c.text}
                  />
                  <Text style={s.groupCardChipText}>{isHost ? 'Host' : 'Member'}</Text>
                </View>
              </View>

              {isHost && (
                <View style={s.codeBlock}>
                  <Text style={s.codeLabel}>Invite code</Text>
                  <Text style={s.codeValue}>
                    {myGroup.group.invite_code.slice(0, 3)} {myGroup.group.invite_code.slice(3)}
                  </Text>
                </View>
              )}
            </GlassCard>

            <View style={s.dangerRow}>
              <PressFx style={s.dangerBtn} onPress={handleLeave}>
                <Feather name="log-out" size={14} color={dangerColor} />
                <Text style={s.dangerBtnText}>Leave</Text>
              </PressFx>
              {isHost && (
                <PressFx style={s.dangerBtn} onPress={handleDelete}>
                  <Feather name="trash-2" size={14} color={dangerColor} />
                  <Text style={s.dangerBtnText}>Delete</Text>
                </PressFx>
              )}
            </View>
          </>
        ) : (
          <>
            <Text style={s.secH}>Set up roomies</Text>

            <PressFx
              style={s.optionCard}
              onPress={() => setAddrModalVisible(true)}
              disabled={creatingGroup}
            >
              <View style={s.optionIcon}>
                {creatingGroup ? (
                  <LoadingBars size="small" color="#F5A300" />
                ) : (
                  <Feather name="home" size={20} color="#F5A300" />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.optionTitle}>Enable for my address</Text>
                <Text style={s.optionSub}>Create a household and share an invite code</Text>
              </View>
              <Feather name="chevron-right" size={16} color={c.textMuted} />
            </PressFx>

            <PressFx
              style={s.optionCard}
              onPress={() => navigation.navigate('RoomiesJoin')}
            >
              <View style={s.optionIcon}>
                <Feather name="key" size={20} color="#F5A300" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.optionTitle}>Join with a code</Text>
                <Text style={s.optionSub}>Enter a 6-digit code from your housemate</Text>
              </View>
              <Feather name="chevron-right" size={16} color={c.textMuted} />
            </PressFx>
          </>
        )}
      </View>

      <Modal
        visible={addrModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setAddrModalVisible(false)}
      >
        <Pressable style={s.modal} onPress={() => setAddrModalVisible(false)}>
          <Pressable
            style={[s.sheet, { paddingBottom: 24 + insets.bottom }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle}>Select an address</Text>
            <FlatList
              data={addresses}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <PressFx style={s.addrItem} onPress={() => handleSelectAddress(item)}>
                  <View style={s.addrIcon}>
                    <Feather
                      name={
                        item.tag === 'Home'
                          ? 'home'
                          : item.tag === 'Work'
                          ? 'briefcase'
                          : 'map-pin'
                      }
                      size={16}
                      color="#F5A300"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.addrTitle}>{item.title || item.tag}</Text>
                    <Text style={s.addrSub} numberOfLines={1}>
                      {item.full_address}
                    </Text>
                  </View>
                </PressFx>
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
    </View>
  );
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors).
// useC() keeps dark pixel-identical (#0A0A0A bg / #F5A300 amber) and carries
// the cream + amber light palette, matching the other migrated screens.
// Amber fills (#F5A300) are identical in both themes, so ink-on-amber and amber
// icons stay literal. Raised surfaces (sheet) and danger fork explicitly below.
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Raised sheet surface (#141414) has no useC equivalent → documented literal
  // in dark (keeps it identical); white card in light. Light card gets a subtle
  // border + soft shadow so it reads on the cream bg (dark stays as-is).
  const sheet = isDark ? '#141414' : c.white;
  const lightCard = isDark
    ? null
    : {
        shadowColor: '#000',
        shadowOpacity: 0.04,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 1,
      };
  // Modal scrim + amber-card inset: dark-on-dark fills kept exact in dark,
  // ink-tinted equivalents in light.
  const scrim = isDark ? 'rgba(0,0,0,0.6)' : 'rgba(13,13,15,0.35)';
  const codeBlockBg = isDark ? 'rgba(0,0,0,0.28)' : 'rgba(13,13,15,0.05)';
  // Chip fill is brighter than glassHi (0.08 vs 0.06) → keep dark exact, light
  // uses the glassHi token.
  const chipFill = isDark ? 'rgba(255,255,255,0.08)' : c.glassHi;
  // Sheet drag handle is brighter than any token (0.18) → keep dark exact, ink
  // equivalent in light.
  const handleBg = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(13,13,15,0.18)';
  // Danger red kept exact in dark; light uses the readable token red.
  const danger = isDark ? '#EF4444' : c.danger;

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

  body: { flex: 1, paddingHorizontal: H_PAD, paddingTop: 6 },

  secH: {
    ...fontBold,
    fontSize: 11,
    color: c.textMuted,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    paddingTop: 18,
    paddingBottom: 12,
    paddingLeft: 4,
  },

  // Option cards
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 18,
    backgroundColor: c.glass,
    borderWidth: 0.5,
    borderColor: c.glassBorder,
    marginBottom: 10,
  },
  optionIcon: {
    width: 42, height: 42, borderRadius: 14,
    backgroundColor: c.amberSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  optionTitle: {
    ...fontSemi,
    fontSize: 14,
    color: c.text,
    letterSpacing: -0.1,
  },
  optionSub: {
    ...fontMed,
    fontSize: 11.5,
    color: c.textMuted,
    marginTop: 2,
  },

  // Active group hero card
  groupCard: {
    padding: 18,
    marginTop: 14,
  },
  groupCardLabel: {
    ...fontBold,
    fontSize: 10,
    color: c.textSecondary,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  groupCardName: {
    ...fontExtra,
    fontSize: 22,
    color: c.text,
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  groupCardRow: { flexDirection: 'row', gap: 8 },
  groupCardChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: chipFill,
    borderRadius: 99,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  groupCardChipText: {
    ...fontSemi,
    fontSize: 11,
    color: c.text,
  },
  codeBlock: {
    marginTop: 16,
    backgroundColor: codeBlockBg,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: 'rgba(245,163,0,0.25)',
  },
  codeLabel: {
    ...fontBold,
    fontSize: 9,
    color: c.textSecondary,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  codeValue: {
    ...fontExtra,
    fontSize: 28,
    color: c.amber,
    letterSpacing: 6,
  },

  dangerRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  dangerBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.dangerBorder,
    backgroundColor: c.dangerSoft,
  },
  dangerBtnText: {
    ...fontBold,
    fontSize: 13,
    color: danger,
    letterSpacing: 0.1,
  },

  // Address picker sheet
  modal: { flex: 1, backgroundColor: scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: sheet,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    maxHeight: '70%',
    borderWidth: 0.5,
    borderColor: c.glassBorder,
    ...(lightCard || {}),
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: handleBg,
    alignSelf: 'center',
    marginBottom: 14,
  },
  sheetTitle: {
    ...fontBold,
    fontSize: 16,
    color: c.text,
    paddingHorizontal: 20,
    marginBottom: 8,
    letterSpacing: -0.2,
  },
  addrItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: c.divider,
  },
  addrIcon: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: c.amberSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  addrTitle: {
    ...fontSemi,
    fontSize: 14, color: c.text,
  },
  addrSub: {
    ...fontMed,
    fontSize: 12,
    color: c.textSecondary,
    marginTop: 2,
  },
  emptyAddr: { paddingVertical: 40, alignItems: 'center' },
  emptyAddrText: {
    ...fontMed,
    fontSize: 13,
    color: c.textMuted,
  },
  });
}
