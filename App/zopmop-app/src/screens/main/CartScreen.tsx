import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useCart } from '../../context/CartContext';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { listAddresses, type ApiAddress } from '../../api/addresses';
import { createScheduledBooking, getBookings } from '../../api/bookings';
import SchedulingModal from '../../components/SchedulingModal';
import AddressPickerModal from '../../components/AddressPickerModal';
import * as Location from 'expo-location';
import { promoStore } from '../../utils/promoStore';

type Nav = NativeStackNavigationProp<MainStackParamList>;
type C = typeof lightColors;

const PLATFORM_FEE_CENTS = 2000; // ₹20

/** Minimal UUID v4 — no external dep needed. */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function createStyles(c: C) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    scroll: { flex: 1 },
    content: { padding: 16, gap: 12 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: c.white,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    backBtn: {
      width: 36, height: 36, borderRadius: Radius.full,
      backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
    },
    backIcon: { fontSize: 18, color: c.text, marginTop: -1 },
    headerTitle: {
      flex: 1, textAlign: 'center',
      fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text,
    },
    card: {
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      padding: 16,
      borderWidth: 1,
      borderColor: c.border,
      ...Shadow.sm,
      gap: 8,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    cardLabel: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.text },
    editLink: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.primary },
    addressTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text },
    addressFull: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    addAddressText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.primary, paddingVertical: 4 },
    slotLabel: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.primary },
    slotPlaceholder: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted },
    serviceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
    serviceRowBorder: { borderTopWidth: 1, borderTopColor: c.border },
    serviceLeft: { flex: 1 },
    serviceName: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.text },
    serviceDuration: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, marginTop: 2 },
    serviceRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    servicePrice: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text },
    removeBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    removeBtnText: { fontSize: 14, color: c.danger, fontFamily: FontFamily.semibold },
    priceRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
    priceKey: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    priceVal: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.text },
    totalRow: { borderTopWidth: 1, borderTopColor: c.border, marginTop: 6, paddingTop: 10 },
    totalKey: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text },
    totalVal: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.primary },
    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
    emptyEmoji: { fontSize: 56, marginBottom: 4 },
    emptyTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: c.text },
    emptySub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center' },
    browseBtn: {
      marginTop: 8, backgroundColor: c.primary,
      paddingHorizontal: 28, paddingVertical: 12, borderRadius: Radius.xl, ...Shadow.sm,
    },
    browseBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: '#FFFFFF' },
    bottomBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16, paddingVertical: 12,
      backgroundColor: c.white,
      borderTopWidth: 1, borderTopColor: c.border,
      gap: 16,
      ...Shadow.md,
    },
    totalInfo: { flex: 1 },
    totalInfoLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },
    totalInfoValue: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: c.text },
    payBtn: {
      flex: 1, backgroundColor: c.primary,
      borderRadius: Radius.xl, paddingVertical: 14,
      alignItems: 'center', ...Shadow.sm,
    },
    payBtnDisabled: { opacity: 0.6 },
    payBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: '#FFFFFF' },

    // ── Roomies split card ─────────────────────────────────────────────────────
    roomiesCard: {
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      padding: 16,
      borderWidth: 1.5,
      borderColor: c.primary,
      ...Shadow.sm,
      gap: 10,
    },
    roomiesHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    roomiesLabelBlock: { flex: 1 },
    roomiesLabel: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.text },
    roomiesSubtext: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, marginTop: 1 },
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
    memberRowBorder: { borderTopWidth: 1, borderTopColor: c.border },
    memberAvatar: {
      width: 32, height: 32, borderRadius: 16,
      backgroundColor: c.primary + '22',
      alignItems: 'center', justifyContent: 'center',
    },
    memberAvatarText: { fontSize: 15 },
    memberInfo: { flex: 1 },
    memberName: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.text },
    memberVault: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, marginTop: 1 },
    checkbox: {
      width: 22, height: 22, borderRadius: 6,
      borderWidth: 2, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
    },
    checkboxActive: { borderColor: c.primary, backgroundColor: c.primary },
    checkboxTick: { color: '#fff', fontSize: 12, fontFamily: FontFamily.bold },
    splitSummaryBox: {
      backgroundColor: c.primary + '10',
      borderRadius: Radius.md,
      padding: 10,
      gap: 4,
    },
    splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    splitKey: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textSecondary },
    splitVal: { fontFamily: FontFamily.medium, fontSize: FontSize.xs, color: c.text },
    splitShareKey: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.text },
    splitShareVal: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.primary },
    splitDivider: { height: 1, backgroundColor: c.border, marginVertical: 4 },
    splitNote: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, textAlign: 'center' },
  });
}

export default function CartScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<NativeStackScreenProps<MainStackParamList, 'Cart'>['route']>();
  const { items, itemCount, subtotalCents, removeItem, refreshCart } = useCart();
  const { token, user } = useAuth();
  const { myGroup, bookGroupChore } = useRoomies();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<ApiAddress | null>(null);
  const [addressPickerVisible, setAddressPickerVisible] = useState(false);
  const [schedulingVisible, setSchedulingVisible] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedSlotLabel, setSelectedSlotLabel] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const bookingInFlight = useRef(false);

  // ── Roomies split ──────────────────────────────────────────────────────────
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  /** True only when the selected address is the group's registered address. */
  const isRoomiesAddress =
    !!myGroup && !!selectedAddress && selectedAddress.id === myGroup.group.address_id;

  /** Group members other than the current user. */
  const otherMembers = useMemo(
    () => (myGroup?.members ?? []).filter((m) => m.user_id !== user?.id),
    [myGroup, user?.id],
  );

  /** Reset/initialise split whenever the selected address changes. */
  useEffect(() => {
    if (!isRoomiesAddress) {
      setSplitEnabled(false);
      setSelectedMemberIds(new Set());
    } else {
      // Pre-select everyone by default.
      setSelectedMemberIds(new Set(otherMembers.map((m) => m.user_id)));
    }
  }, [selectedAddress?.id, isRoomiesAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const splitCount = splitEnabled && selectedMemberIds.size > 0 ? selectedMemberIds.size + 1 : 1;
  const feeCents = PLATFORM_FEE_CENTS;
  const totalCents = subtotalCents + feeCents;
  const myShareCents = splitCount > 1 ? Math.ceil(totalCents / splitCount) : totalCents;

  function toggleMember(userId: string) {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  // ── Address loading ────────────────────────────────────────────────────────
  async function loadAddresses() {
    if (!token) return;
    try {
      const list = await listAddresses(token);
      setAddresses(list);
      if (list.length === 0) return;

      const preselectedId = route.params?.selectedAddressId;
      if (preselectedId) {
        const preselected = list.find(a => a.id === preselectedId);
        if (preselected) { setSelectedAddress(preselected); return; }
      }

      let picked: ApiAddress | null = null;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          const { latitude, longitude } = pos.coords;
          let minDist = Infinity;
          for (const addr of list) {
            const d = Math.hypot(addr.lat - latitude, addr.lon - longitude);
            if (d < minDist) { minDist = d; picked = addr; }
          }
          if (minDist > 0.009) picked = null;
        }
      } catch { /* location unavailable */ }

      if (!picked) {
        try {
          const past = await getBookings(token, 'past', 1);
          if (past.length > 0 && past[0].address_id) {
            picked = list.find(a => a.id === past[0].address_id) ?? null;
          }
        } catch { /* no past bookings */ }
      }

      setSelectedAddress(picked ?? list[0]);
    } catch (err) {
      console.error('[Cart] failed to load addresses', err);
      Alert.alert('Could not load addresses', 'Check your connection and try again.');
    }
  }

  useEffect(() => { loadAddresses(); }, [token]);

  const handleRemove = useCallback(async (itemId: string) => {
    setRemoving(itemId);
    try {
      await removeItem(itemId);
    } finally {
      setRemoving(null);
    }
  }, [removeItem]);

  // ── Checkout ───────────────────────────────────────────────────────────────
  const handleCheckout = useCallback(async () => {
    if (!token) return;
    if (!selectedAddress) {
      Alert.alert('No address', 'Please select a delivery address.');
      return;
    }
    if (!selectedSlotId) {
      Alert.alert('No time selected', 'Please select a date and time slot.');
      return;
    }
    if (itemCount === 0) return;
    if (bookingInFlight.current) return;

    const doSplit = splitEnabled && !!myGroup && selectedMemberIds.size > 0;

    bookingInFlight.current = true;
    setBooking(true);
    const promoCode = promoStore.get() ?? undefined;
    console.info('[Cart] checkout start', {
      addressId: selectedAddress.id,
      slotId: selectedSlotId,
      itemCount,
      hasPromo: !!promoCode,
      split: doSplit,
      splitCount,
    });

    try {
      // Step 1: create the actual scheduled booking.
      const created = await createScheduledBooking(token, {
        address_id: selectedAddress.id,
        time_slot_id: selectedSlotId,
        ...(promoCode ? { promo_code: promoCode } : {}),
      });
      console.info('[Cart] booking created');

      // Step 2 (optional): record roomies cost distribution.
      if (doSplit && myGroup) {
        try {
          await bookGroupChore(myGroup.group.id, {
            total_amount: totalCents,
            selected_member_ids: [...selectedMemberIds],
            idempotency_key: generateUUID(),
          });
          console.info('[Cart] roomies cost split recorded');
        } catch (splitErr) {
          console.warn('[Cart] split recording failed — booking still confirmed', splitErr);
        }
      }

      promoStore.clear();
      await refreshCart();

      navigation.replace('BookingConfirmed', {
        bookingId: created.id,
        totalCents,
        slot: selectedSlotLabel ?? undefined,
        addressLine: selectedAddress.full_address ?? selectedAddress.title ?? undefined,
      });
    } catch (err: any) {
      const msg =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        err?.message ??
        'Something went wrong. Please try again.';
      console.error('[Cart] booking failed', err?.response?.data ?? err?.message);
      Alert.alert('Booking Failed', msg);
    } finally {
      setBooking(false);
      bookingInFlight.current = false;
    }
  }, [
    token, selectedAddress, selectedSlotId, itemCount, refreshCart, navigation,
    splitEnabled, myGroup, selectedMemberIds, totalCents, myShareCents, splitCount, bookGroupChore,
  ]);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (itemCount === 0) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
        <View style={s.header}>
          <TouchableOpacity style={s.backBtn} onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home')} activeOpacity={0.7} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Cart</Text>
          <View style={{ width: 36 }} />
        </View>
        <View style={s.emptyState}>
          <Text style={s.emptyEmoji}>🛒</Text>
          <Text style={s.emptyTitle}>Your cart is empty</Text>
          <Text style={s.emptySub}>Add services from the home screen to get started</Text>
          <TouchableOpacity style={s.browseBtn} onPress={() => navigation.goBack()} activeOpacity={0.85}>
            <Text style={s.browseBtnText}>Browse Services</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home')} activeOpacity={0.7} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Cart ({itemCount})</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>

        {/* ── Address ──────────────────────────────────────────────────────── */}
        <TouchableOpacity style={s.card} activeOpacity={0.8} onPress={() => setAddressPickerVisible(true)}>
          <View style={s.cardHeader}>
            <Text style={s.cardLabel}>📍 Delivery Address</Text>
            <Text style={s.editLink}>{selectedAddress ? 'Change' : 'Add'}</Text>
          </View>
          {selectedAddress ? (
            <>
              <Text style={s.addressTitle}>{selectedAddress.title || selectedAddress.tag}</Text>
              <Text style={s.addressFull} numberOfLines={2}>{selectedAddress.full_address}</Text>
            </>
          ) : (
            <Text style={s.addAddressText}>+ Add an address</Text>
          )}
        </TouchableOpacity>

        {/* ── Roomies Split Card — visible only when address matches group ── */}
        {isRoomiesAddress && (
          <View style={s.roomiesCard}>
            {/* Toggle row */}
            <View style={s.roomiesHeaderRow}>
              <Text style={s.memberAvatarText}>🏠</Text>
              <View style={s.roomiesLabelBlock}>
                <Text style={s.roomiesLabel}>Split with Roomies</Text>
                <Text style={s.roomiesSubtext}>
                  {splitEnabled
                    ? `Splitting with ${selectedMemberIds.size} roomie${selectedMemberIds.size !== 1 ? 's' : ''}`
                    : 'Tap to divide costs with your household'}
                </Text>
              </View>
              <Switch
                value={splitEnabled}
                onValueChange={(val) => {
                  setSplitEnabled(val);
                  if (val && selectedMemberIds.size === 0) {
                    setSelectedMemberIds(new Set(otherMembers.map((m) => m.user_id)));
                  }
                }}
                trackColor={{ false: c.border, true: c.primary + '80' }}
                thumbColor={splitEnabled ? c.primary : c.textMuted}
              />
            </View>

            {/* Member list + breakdown (visible when toggled on) */}
            {splitEnabled && (
              <>
                {otherMembers.length === 0 ? (
                  <Text style={s.splitNote}>
                    You're the only member in this group. Invite roomies to split costs.
                  </Text>
                ) : (
                  <>
                    <Text style={[s.splitKey, { marginBottom: -2 }]}>Who to split with:</Text>

                    {otherMembers.map((member, i) => {
                      const isSelected = selectedMemberIds.has(member.user_id);
                      const isHost = member.role === 'host';
                      return (
                        <TouchableOpacity
                          key={member.user_id}
                          style={[s.memberRow, i > 0 && s.memberRowBorder]}
                          activeOpacity={0.7}
                          onPress={() => toggleMember(member.user_id)}
                        >
                          <View style={s.memberAvatar}>
                            <Text style={s.memberAvatarText}>{isHost ? '👑' : '👤'}</Text>
                          </View>
                          <View style={s.memberInfo}>
                            <Text style={s.memberName}>{isHost ? 'Host' : `Roomie ${i + 1}`}</Text>
                            <Text style={s.memberVault}>
                              {member.prepaid_balance > 0
                                ? `Vault: ₹${(member.prepaid_balance / 100).toFixed(0)}`
                                : 'No vault balance'}
                            </Text>
                          </View>
                          <View style={[s.checkbox, isSelected && s.checkboxActive]}>
                            {isSelected && <Text style={s.checkboxTick}>✓</Text>}
                          </View>
                        </TouchableOpacity>
                      );
                    })}

                    {/* Cost breakdown summary */}
                    <View style={s.splitSummaryBox}>
                      <View style={s.splitRow}>
                        <Text style={s.splitKey}>Total order</Text>
                        <Text style={s.splitVal}>₹{(totalCents / 100).toFixed(0)}</Text>
                      </View>
                      <View style={s.splitRow}>
                        <Text style={s.splitKey}>Split between</Text>
                        <Text style={s.splitVal}>{splitCount} people</Text>
                      </View>
                      {selectedMemberIds.size === 0 && (
                        <Text style={[s.splitNote, { textAlign: 'left', marginTop: 2 }]}>
                          Select at least one roomie to split costs.
                        </Text>
                      )}
                      {selectedMemberIds.size > 0 && (
                        <>
                          <View style={s.splitDivider} />
                          <View style={s.splitRow}>
                            <Text style={s.splitShareKey}>Your share</Text>
                            <Text style={s.splitShareVal}>₹{(myShareCents / 100).toFixed(0)}</Text>
                          </View>
                        </>
                      )}
                    </View>

                    <Text style={s.splitNote}>
                      Roomies pay from Vault balance. Shortfalls become tracked debts.
                    </Text>
                  </>
                )}
              </>
            )}
          </View>
        )}

        {/* ── Schedule ─────────────────────────────────────────────────────── */}
        <TouchableOpacity style={s.card} activeOpacity={0.8} onPress={() => setSchedulingVisible(true)}>
          <View style={s.cardHeader}>
            <Text style={s.cardLabel}>🗓 Schedule</Text>
            <Text style={s.editLink}>Select</Text>
          </View>
          {selectedSlotLabel ? (
            <Text style={s.slotLabel}>{selectedSlotLabel}</Text>
          ) : (
            <Text style={s.slotPlaceholder}>Tap to choose a date & time</Text>
          )}
        </TouchableOpacity>

        {/* ── Services ─────────────────────────────────────────────────────── */}
        <View style={s.card}>
          <Text style={s.cardLabel}>🧹 Services</Text>
          {items.map((item, i) => (
            <View key={item.id} style={[s.serviceRow, i > 0 && s.serviceRowBorder]}>
              <View style={s.serviceLeft}>
                <Text style={s.serviceName}>{item.service_name}</Text>
                <Text style={s.serviceDuration}>{item.duration_minutes} min</Text>
              </View>
              <View style={s.serviceRight}>
                <Text style={s.servicePrice}>₹{(item.price_cents / 100).toFixed(0)}</Text>
                <TouchableOpacity
                  onPress={() => handleRemove(item.id)}
                  activeOpacity={0.7}
                  disabled={removing === item.id}
                  style={s.removeBtn}
                >
                  {removing === item.id
                    ? <ActivityIndicator size="small" color={c.danger} />
                    : <Text style={s.removeBtnText}>✕</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>

        {/* ── Price Summary ─────────────────────────────────────────────────── */}
        <View style={s.card}>
          <Text style={s.cardLabel}>💰 Price Summary</Text>
          <View style={s.priceRow}>
            <Text style={s.priceKey}>Subtotal</Text>
            <Text style={s.priceVal}>₹{(subtotalCents / 100).toFixed(0)}</Text>
          </View>
          <View style={s.priceRow}>
            <Text style={s.priceKey}>Platform fee</Text>
            <Text style={s.priceVal}>₹{(feeCents / 100).toFixed(0)}</Text>
          </View>
          <View style={[s.priceRow, s.totalRow]}>
            <Text style={s.totalKey}>Total</Text>
            <Text style={s.totalVal}>₹{(totalCents / 100).toFixed(0)}</Text>
          </View>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* ── Sticky bottom bar ─────────────────────────────────────────────── */}
      <View style={s.bottomBar}>
        <View style={s.totalInfo}>
          <Text style={s.totalInfoLabel}>
            {splitEnabled && splitCount > 1 ? 'Your share' : 'Total'}
          </Text>
          <Text style={s.totalInfoValue}>₹{(myShareCents / 100).toFixed(0)}</Text>
        </View>
        <TouchableOpacity
          style={[s.payBtn, booking && s.payBtnDisabled]}
          activeOpacity={0.85}
          disabled={booking}
          onPress={handleCheckout}
        >
          {booking
            ? <ActivityIndicator color="#FFFFFF" />
            : <Text style={s.payBtnText}>Confirm Booking</Text>
          }
        </TouchableOpacity>
      </View>

      <SchedulingModal
        visible={schedulingVisible}
        token={token ?? ''}
        onClose={() => setSchedulingVisible(false)}
        onConfirm={(slotId, label) => {
          setSelectedSlotId(slotId);
          setSelectedSlotLabel(label);
          setSchedulingVisible(false);
        }}
      />

      <AddressPickerModal
        visible={addressPickerVisible}
        token={token}
        addresses={addresses}
        selectedId={selectedAddress?.id ?? null}
        onSelect={addr => setSelectedAddress(addr)}
        onClose={() => setAddressPickerVisible(false)}
        onAddressEdited={updated => setAddresses(prev => prev.map(a => a.id === updated.id ? updated : a))}
        onAddressDeleted={id => {
          setAddresses(prev => {
            const next = prev.filter(a => a.id !== id);
            if (selectedAddress?.id === id) setSelectedAddress(next[0] ?? null);
            return next;
          });
        }}
        onRefreshAddresses={async (newLat?: number, newLon?: number) => {
          if (!token) return;
          try {
            const list = await listAddresses(token);
            setAddresses(list);
            if (newLat !== undefined && newLon !== undefined && list.length > 0) {
              let best = list[0];
              let minD = Infinity;
              for (const a of list) {
                const d = Math.hypot(a.lat - newLat, a.lon - newLon);
                if (d < minD) { minD = d; best = a; }
              }
              setSelectedAddress(best);
            }
          } catch { /* ignore */ }
        }}
      />
    </SafeAreaView>
  );
}
