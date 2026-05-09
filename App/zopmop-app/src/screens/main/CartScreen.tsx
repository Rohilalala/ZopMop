import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  
  Alert,
  Animated,
  Easing,
  Image,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient as SvgRadialGradient,
  Stop,
  Rect,
} from 'react-native-svg';
import ReAnimated, { FadeOutLeft } from 'react-native-reanimated';
import * as Location from 'expo-location';
import type { MainStackParamList } from '../../types/navigation';
import { FontFamily } from '../../theme';
import { C } from '../../theme/screen';
import { BackgroundGlow, ScreenHeader, SectionHeader, Card } from '../../components/screen/ScreenChrome';
import { useCart } from '../../context/CartContext';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { listAddresses, type ApiAddress } from '../../api/addresses';
import { createScheduledBooking, getBookings } from '../../api/bookings';
import { UnpaidBookingsError } from '../../api/users';
import { getWalletBalance } from '../../api/wallet';
import SchedulingModal from '../../components/SchedulingModal';
import AddressPickerModal from '../../components/AddressPickerModal';
import { promoStore } from '../../utils/promoStore';
import { haptics } from '../../utils/haptics';
import { showError } from '../../utils/toast';
import { usePostHog } from 'posthog-react-native';
import { PrimaryButton } from '../../components/PrimaryButton';
import { serviceIcon } from '../../components/home/serviceIcon';
import { CartScreenSkeleton } from '../../components/skeletons/CartScreenSkeleton';
import { EmptyState } from '../../components/EmptyState';
import ZopHappy from '../../../assets/zop/zop-happy.svg';

type Nav = NativeStackNavigationProp<MainStackParamList>;

const PLATFORM_FEE_CENTS = 2000;

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Module-level cache: keeps last fetched addresses + selection so re-opening
// Cart from Home doesn't flash the skeleton while we re-load identical data.
const cartMemCache: {
  addresses: ApiAddress[];
  selectedAddress: ApiAddress | null;
} = { addresses: [], selectedAddress: null };

export default function CartScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<NativeStackScreenProps<MainStackParamList, 'Cart'>['route']>();
  const { items, itemCount, subtotalCents, removeItem, refreshCart } = useCart();
  const { token, user } = useAuth();
  const { myGroup, bookGroupChore } = useRoomies();
  const insets = useSafeAreaInsets();
  const posthog = usePostHog();

  const [addresses, setAddresses] = useState<ApiAddress[]>(cartMemCache.addresses);
  const [selectedAddress, setSelectedAddress] = useState<ApiAddress | null>(cartMemCache.selectedAddress);
  const [hydrating, setHydrating] = useState(cartMemCache.addresses.length === 0);
  const [addressPickerVisible, setAddressPickerVisible] = useState(false);
  const [schedulingVisible, setSchedulingVisible] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedSlotLabel, setSelectedSlotLabel] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const bookingInFlight = useRef(false);

  const [splitEnabled, setSplitEnabled] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  // Payment-source picker state. Direct = Cashfree drop sheet via Payment
  // route. Wallet = backend debits inline at booking-create time.
  const [paymentSource, setPaymentSource] = useState<'direct' | 'wallet'>('direct');
  // null = haven't fetched yet; treat as unknown for UI gating purposes.
  const [walletBalance, setWalletBalance] = useState<number | null>(null);

  const refetchWalletBalance = useCallback(async () => {
    if (!token) return;
    try {
      const r = await getWalletBalance(token);
      setWalletBalance(r.balance_paise);
    } catch {
      // Soft-fail: treat as 0 so the picker degrades gracefully when the
      // wallet endpoint is unreachable (server outage, network blip).
      // Customer can still pay-now; wallet card just shows insufficient.
      setWalletBalance(0);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      refetchWalletBalance();
    }, [refetchWalletBalance]),
  );

  const isRoomiesAddress =
    !!myGroup && !!selectedAddress && selectedAddress.id === myGroup.group.address_id;

  const otherMembers = useMemo(
    () => (myGroup?.members ?? []).filter((m) => m.user_id !== user?.id),
    [myGroup, user?.id],
  );

  useEffect(() => {
    if (!isRoomiesAddress) {
      setSplitEnabled(false);
      setSelectedMemberIds(new Set());
    } else {
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

  async function loadAddresses() {
    if (!token) return;
    try {
      const list = await listAddresses(token);
      setAddresses(list);
      cartMemCache.addresses = list;
      if (list.length === 0) return;

      const preselectedId = route.params?.selectedAddressId;
      if (preselectedId) {
        const preselected = list.find((a) => a.id === preselectedId);
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
      } catch {}

      if (!picked) {
        try {
          const past = await getBookings(token, 'past', 1);
          if (past.length > 0 && past[0].address_id) {
            picked = list.find((a) => a.id === past[0].address_id) ?? null;
          }
        } catch {}
      }

      const finalSelected = picked ?? list[0];
      setSelectedAddress(finalSelected);
      cartMemCache.selectedAddress = finalSelected;
    } catch (err) {
      console.error('[Cart] failed to load addresses', err);
      showError('Check your connection and try again.', { title: 'Could not load addresses' });
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      await Promise.all([refreshCart(), loadAddresses()]);
      if (active) setHydrating(false);
    })();
    return () => { active = false; };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRemove = useCallback(async (itemId: string) => {
    setRemoving(itemId);
    try {
      const removed = items.find((i) => i.id === itemId);
      await removeItem(itemId);
      posthog.capture('service_removed_from_cart', {
        service_id: removed?.service_id ?? null,
        service_name: removed?.service_name ?? null,
        price_cents: removed?.price_cents ?? null,
      });
    } finally { setRemoving(null); }
  }, [removeItem, items, posthog]);

  const handleCheckout = useCallback(async () => {
    if (!token) return;
    if (!selectedAddress) { showError('Please select a delivery address.', { title: 'No address' }); return; }
    if (!selectedSlotId) { showError('Please pick a date and time slot.', { title: 'No time selected' }); return; }
    if (itemCount === 0) return;
    if (bookingInFlight.current) return;

    // Wallet pre-flight: defense in depth. Card B disables itself when
    // balance < total, but a stale balance + race on the focus refetch
    // could let the user submit anyway — catch here too.
    if (paymentSource === 'wallet') {
      if (walletBalance == null || walletBalance < totalCents) {
        showError('Insufficient wallet balance.', { title: 'Top up first' });
        return;
      }
    }

    haptics.medium();

    posthog.capture('booking_checkout_started', {
      item_count: itemCount,
      subtotal_cents: subtotalCents,
      total_cents: totalCents,
      payment_source: paymentSource,
      has_promo: !!promoStore.get(),
      split_enabled: splitEnabled,
    });

    const doSplit = splitEnabled && !!myGroup && selectedMemberIds.size > 0;

    bookingInFlight.current = true;
    setBooking(true);
    const promoCode = promoStore.get() ?? undefined;
    try {
      const created = await createScheduledBooking(token, {
        address_id: selectedAddress.id,
        time_slot_id: selectedSlotId,
        ...(promoCode ? { promo_code: promoCode } : {}),
        payment_source: paymentSource,
      });

      posthog.capture('booking_confirmed', {
        booking_id: created.id,
        total_cents: totalCents,
        payment_source: paymentSource,
        split_enabled: doSplit,
        split_count: splitCount,
        has_promo: !!promoCode,
      });

      if (doSplit && myGroup) {
        try {
          await bookGroupChore(myGroup.group.id, {
            total_amount: totalCents,
            selected_member_ids: [...selectedMemberIds],
            idempotency_key: generateUUID(),
          });
        } catch (splitErr) {
          console.warn('[Cart] split recording failed — booking still confirmed', splitErr);
        }
      }

      promoStore.clear();
      await refreshCart();

      if (paymentSource === 'direct') {
        // Booking exists in 'pending'. Hand off to the Cashfree drop
        // sheet flow — PaymentScreen owns order creation + SDK launch.
        posthog.capture('booking_payment_initiated', {
          booking_id: created.id,
          amount_paise: created.price_cents,
        });
        navigation.replace('Payment', {
          booking_id: created.id,
          // JSON field is back-compat; value is paise (see backend
          // migration 065). No * 100 conversion needed.
          amount_paise: created.price_cents,
        });
        return;
      }

      // payment_source === 'wallet': backend has already debited the
      // wallet inside the same tx as the booking insert + booking.paid
      // outbox emit. Skip Cashfree entirely.
      navigation.replace('BookingConfirmed', {
        bookingId: created.id,
        totalCents,
        slot: selectedSlotLabel ?? undefined,
        addressLine: selectedAddress.full_address ?? selectedAddress.title ?? undefined,
      });
    } catch (err: any) {
      if (err instanceof UnpaidBookingsError) {
        // Customer has completed-but-unpaid Cashfree bookings; route them
        // to the bookings list to settle before re-trying.
        const totalRupees = (err.totalPaise / 100).toFixed(2);
        Alert.alert(
          'Settle pending payments',
          `You have ${err.count} unpaid booking(s) totaling ₹${totalRupees}. Please settle them before booking again.`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'View Bookings', onPress: () => navigation.navigate('Bookings') },
          ],
        );
        return;
      }

      const code: string | undefined = err?.response?.data?.code ?? err?.code;
      const msg: string =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        err?.message ??
        'Something went wrong. Please try again.';

      if (paymentSource === 'wallet' && code === 'INSUFFICIENT_WALLET_BALANCE') {
        // Race: balance dropped below required between focus-refetch and
        // submit. Don't auto-flip selection — that's hostile UX. Tell the
        // user, refresh balance, leave them on Cart.
        showError(
          'Wallet balance dropped below required amount. Top up or switch to Pay now.',
          { title: 'Insufficient balance' },
        );
        refetchWalletBalance();
      } else {
        showError(msg, { title: 'Booking failed' });
      }
    } finally {
      setBooking(false);
      bookingInFlight.current = false;
    }
  }, [
    token, selectedAddress, selectedSlotId, itemCount, refreshCart, navigation,
    splitEnabled, myGroup, selectedMemberIds, totalCents, splitCount, bookGroupChore, selectedSlotLabel,
    paymentSource, walletBalance, refetchWalletBalance, subtotalCents, posthog,
  ]);

  if (hydrating) {
    return (
      <View style={s.root}>
        <BackgroundGlow />
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <ScreenHeader
            title="Cart"
            onBack={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home')}
          />
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 130 + insets.bottom }}
            showsVerticalScrollIndicator={false}
          >
            <CartScreenSkeleton />
          </ScrollView>
        </SafeAreaView>
      </View>
    );
  }

  if (itemCount === 0) {
    return (
      <View style={s.root}>
        <BackgroundGlow />
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <ScreenHeader
            title="Cart"
            onBack={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home')}
          />
          <EmptyState
            illustration={<FloatingZop />}
            title="Let's get cleaning!"
            subtitle="Pick a service and Zop will send a pro your way."
            ctaLabel="Browse services"
            onCtaPress={() => navigation.navigate('AllServices', {})}
            style={{ flex: 1 }}
          />
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <BackgroundGlow />

      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader
          title={`Cart`}
          subtitle={`${itemCount} item${itemCount === 1 ? '' : 's'} · ready to confirm`}
          onBack={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home')}
        />

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 130 + insets.bottom }}
          showsVerticalScrollIndicator={false}
        >
          <SectionHeader>Address</SectionHeader>
          <TouchableOpacity activeOpacity={0.85} onPress={() => setAddressPickerVisible(true)}>
            <Card>
              <View style={s.addrRow}>
                <View style={s.addrPin}>
                  <Feather name="map-pin" size={16} color={C.amber} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {selectedAddress ? (
                    <>
                      <Text style={s.addrTitle}>{selectedAddress.title || selectedAddress.tag}</Text>
                      <Text style={s.addrSub} numberOfLines={2}>{selectedAddress.full_address}</Text>
                    </>
                  ) : (
                    <Text style={s.addrTitle}>Add delivery address</Text>
                  )}
                </View>
                <Text style={s.changeLink}>{selectedAddress ? 'Change' : 'Add'}</Text>
              </View>
            </Card>
          </TouchableOpacity>

          {isRoomiesAddress && (
            <>
              <SectionHeader>Roomies split</SectionHeader>
              <Card>
                <View style={s.splitHeader}>
                  <View style={s.splitIcon}>
                    <Feather name="home" size={16} color={C.amber} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.splitTitle}>Split with Roomies</Text>
                    <Text style={s.splitMeta}>
                      {splitEnabled
                        ? `Splitting with ${selectedMemberIds.size} roomie${selectedMemberIds.size === 1 ? '' : 's'}`
                        : 'Tap to divide costs with your household'}
                    </Text>
                  </View>
                  <DarkToggle on={splitEnabled} onChange={(v) => {
                    setSplitEnabled(v);
                    if (v && selectedMemberIds.size === 0) {
                      setSelectedMemberIds(new Set(otherMembers.map((m) => m.user_id)));
                    }
                  }} />
                </View>

                {splitEnabled && (
                  <>
                    {otherMembers.length === 0 ? (
                      <Text style={s.splitNote}>You're the only member in this group. Invite roomies to split costs.</Text>
                    ) : (
                      <>
                        <View style={s.divider} />
                        {otherMembers.map((member, i) => {
                          const sel = selectedMemberIds.has(member.user_id);
                          const isHost = member.role === 'host';
                          return (
                            <TouchableOpacity
                              key={member.user_id}
                              activeOpacity={0.8}
                              onPress={() => toggleMember(member.user_id)}
                              style={[s.memberRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.divider }]}
                            >
                              <View style={s.memberAvatar}>
                                <Feather name={isHost ? 'star' : 'user'} size={14} color={C.amber} />
                              </View>
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={s.memberName}>{isHost ? 'Host' : `Roomie ${i + 1}`}</Text>
                                <Text style={s.memberMeta}>
                                  {member.prepaid_balance > 0
                                    ? `Vault ₹${(member.prepaid_balance / 100).toFixed(0)}`
                                    : 'No vault balance'}
                                </Text>
                              </View>
                              <View style={[s.checkbox, sel && s.checkboxOn]}>
                                {sel && <Feather name="check" size={12} color={C.ink} />}
                              </View>
                            </TouchableOpacity>
                          );
                        })}

                        <View style={s.splitSummary}>
                          <View style={s.splitRow}>
                            <Text style={s.splitKey}>Total order</Text>
                            <Text style={s.splitVal}>₹{(totalCents / 100).toFixed(0)}</Text>
                          </View>
                          <View style={s.splitRow}>
                            <Text style={s.splitKey}>Split between</Text>
                            <Text style={s.splitVal}>{splitCount} people</Text>
                          </View>
                          {selectedMemberIds.size > 0 ? (
                            <>
                              <View style={s.splitDashed} />
                              <View style={s.splitRow}>
                                <Text style={s.splitTotalKey}>Your share</Text>
                                <Text style={s.splitTotalVal}>₹{(myShareCents / 100).toFixed(0)}</Text>
                              </View>
                            </>
                          ) : (
                            <Text style={[s.splitNote, { textAlign: 'left', marginTop: 4 }]}>
                              Select at least one roomie to split costs.
                            </Text>
                          )}
                        </View>
                        <Text style={s.splitNote}>
                          Roomies pay from Vault balance. Shortfalls become tracked debts.
                        </Text>
                      </>
                    )}
                  </>
                )}
              </Card>
            </>
          )}

          <SectionHeader>Schedule</SectionHeader>
          <TouchableOpacity activeOpacity={0.85} onPress={() => setSchedulingVisible(true)}>
            <Card>
              <View style={s.addrRow}>
                <View style={s.addrPin}>
                  <Feather name="calendar" size={16} color={C.amber} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {selectedSlotLabel ? (
                    <>
                      <Text style={s.addrTitle}>{selectedSlotLabel}</Text>
                      <Text style={s.addrSub}>Tap to change</Text>
                    </>
                  ) : (
                    <>
                      <Text style={s.addrTitle}>Pick a date & time</Text>
                      <Text style={s.addrSub}>Required to confirm booking</Text>
                    </>
                  )}
                </View>
                <Text style={s.changeLink}>{selectedSlotLabel ? 'Change' : 'Select'}</Text>
              </View>
            </Card>
          </TouchableOpacity>

          <SectionHeader>Services</SectionHeader>
          <Card>
            {items.map((item, i) => {
              const img = serviceIcon({ id: item.service_id, name: item.service_name });
              return (
                <ReAnimated.View key={item.id} exiting={FadeOutLeft.duration(250)}>
                  <View style={s.svcRow}>
                    <View style={s.svcIcon}>
                      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
                        <Defs>
                          <SvgLinearGradient id={`svcBg-${item.id}`} x1="0" y1="0" x2="0" y2="1">
                            <Stop offset="0%" stopColor="#1A1A1C" />
                            <Stop offset="100%" stopColor="#0F0F11" />
                          </SvgLinearGradient>
                          <SvgRadialGradient id={`svcTop-${item.id}`} cx="50%" cy="18%" rx="120%" ry="90%">
                            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.10" />
                            <Stop offset="60%" stopColor="#FFFFFF" stopOpacity="0" />
                          </SvgRadialGradient>
                          <SvgRadialGradient id={`svcBot-${item.id}`} cx="50%" cy="110%" rx="80%" ry="60%">
                            <Stop offset="0%" stopColor="#F5A300" stopOpacity="0.16" />
                            <Stop offset="70%" stopColor="#F5A300" stopOpacity="0" />
                          </SvgRadialGradient>
                        </Defs>
                        <Rect width="100%" height="100%" rx="11" fill={`url(#svcBg-${item.id})`} />
                        <Rect width="100%" height="100%" rx="11" fill={`url(#svcTop-${item.id})`} />
                        <Rect width="100%" height="100%" rx="11" fill={`url(#svcBot-${item.id})`} />
                      </Svg>
                      {img && <Image source={img} style={s.svcImg} resizeMode="contain" />}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.svcName} numberOfLines={1}>{item.service_name}</Text>
                      <Text style={s.svcMeta}>{item.duration_minutes} min</Text>
                    </View>
                    <Text style={s.svcPrice}>₹{(item.price_cents / 100).toFixed(0)}</Text>
                    <TouchableOpacity
                      onPress={() => handleRemove(item.id)}
                      activeOpacity={0.7}
                      disabled={removing === item.id}
                      style={s.removeBtn}
                      hitSlop={10}
                    >
                      {removing === item.id
                        ? <LoadingBars size="small" color={C.danger} />
                        : <Feather name="x" size={14} color={C.danger} />}
                    </TouchableOpacity>
                  </View>
                  {i < items.length - 1 && <View style={s.divider} />}
                </ReAnimated.View>
              );
            })}
          </Card>

          <SectionHeader>Bill details</SectionHeader>
          <Card>
            <BillRow label="Subtotal" value={`₹${(subtotalCents / 100).toFixed(0)}`} />
            <BillRow label="Platform fee" value={`₹${(feeCents / 100).toFixed(0)}`} />
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>Total to pay</Text>
              <Text style={s.totalValue}>₹{(totalCents / 100).toFixed(0)}</Text>
            </View>
          </Card>

          <SectionHeader>Pay with</SectionHeader>
          <PaymentSourcePicker
            selected={paymentSource}
            onChange={setPaymentSource}
            walletBalanceCents={walletBalance}
            requiredCents={totalCents}
          />
        </ScrollView>

        <View style={[s.payDock, { paddingBottom: 16 + insets.bottom }]}>
          <PrimaryButton
            label={`Confirm booking · ₹${(myShareCents / 100).toFixed(0)}`}
            onPress={handleCheckout}
            isLoading={booking}
            showChevron
          />
        </View>
      </SafeAreaView>

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
        onSelect={(addr) => setSelectedAddress(addr)}
        onClose={() => setAddressPickerVisible(false)}
        onAddressEdited={(updated) => setAddresses((prev) => prev.map((a) => a.id === updated.id ? updated : a))}
        onAddressDeleted={(id) => {
          setAddresses((prev) => {
            const next = prev.filter((a) => a.id !== id);
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
          } catch {}
        }}
      />
    </View>
  );
}

function BillRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.billRow}>
      <Text style={s.billLabel}>{label}</Text>
      <Text style={s.billValue}>{value}</Text>
    </View>
  );
}

function DarkToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const anim = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: on ? 1 : 0,
      duration: 220,
      easing: Easing.bezier(0.37, 1.95, 0.66, 0.56),
      useNativeDriver: false,
    }).start();
  }, [on]);
  const left = anim.interpolate({ inputRange: [0, 1], outputRange: [2, 20] });
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={() => onChange(!on)} style={{ padding: 2 }}>
      <View style={[s.toggleTrack, on ? null : s.toggleOff]}>
        {on && (
          <View style={StyleSheet.absoluteFill}>
            <Svg width="46" height="28">
              <Defs>
                <SvgLinearGradient id="togGrad" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%" stopColor={C.amberHi} />
                  <Stop offset="100%" stopColor={C.amber} />
                </SvgLinearGradient>
              </Defs>
              <Rect width="46" height="28" rx="14" fill="url(#togGrad)" />
            </Svg>
          </View>
        )}
        <Animated.View style={[s.toggleThumb, { left }]} />
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  // Empty state
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 14 },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.amberSoft,
    marginBottom: 8,
  },
  emptyTitle: { fontFamily: FontFamily.bold, fontSize: 20, color: C.white, letterSpacing: -0.4 },
  emptySub: { fontFamily: FontFamily.medium, fontSize: 13, color: C.textMuted, textAlign: 'center', lineHeight: 18 },
  browseBtn: {
    marginTop: 12, height: 50, paddingHorizontal: 28, borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  browseBtnText: { fontFamily: FontFamily.extrabold, fontSize: 14, color: C.ink, letterSpacing: 0.2 },

  // Address row + schedule row
  addrRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  addrPin: {
    width: 36, height: 36, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.amberSoft,
  },
  addrTitle: { fontFamily: FontFamily.bold, fontSize: 14, color: C.white, letterSpacing: -0.1 },
  addrSub: { fontFamily: FontFamily.medium, fontSize: 11.5, color: C.textMuted, marginTop: 2, lineHeight: 15 },
  changeLink: { fontFamily: FontFamily.bold, fontSize: 11.5, color: C.amber, letterSpacing: 0.2 },

  // Roomies split
  splitHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  splitIcon: {
    width: 36, height: 36, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.amberSoft,
  },
  splitTitle: { fontFamily: FontFamily.bold, fontSize: 14, color: C.white, letterSpacing: -0.1 },
  splitMeta: { fontFamily: FontFamily.medium, fontSize: 11.5, color: C.textMuted, marginTop: 2 },
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12,
  },
  memberAvatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.amberSoft,
  },
  memberName: { fontFamily: FontFamily.semibold, fontSize: 13, color: C.white, letterSpacing: -0.05 },
  memberMeta: { fontFamily: FontFamily.medium, fontSize: 11, color: C.textMuted, marginTop: 1 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: C.amber, borderColor: C.amber },
  splitSummary: {
    marginTop: 4,
    backgroundColor: 'rgba(245,163,0,0.06)',
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  splitKey: { fontFamily: FontFamily.medium, fontSize: 12, color: C.textMuted },
  splitVal: { fontFamily: FontFamily.semibold, fontSize: 12, color: C.text },
  splitDashed: {
    height: 1, marginVertical: 4,
    borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: 'rgba(255,255,255,0.10)',
  },
  splitTotalKey: { fontFamily: FontFamily.bold, fontSize: 13, color: C.white },
  splitTotalVal: { fontFamily: FontFamily.bold, fontSize: 13, color: C.amber },
  splitNote: { fontFamily: FontFamily.medium, fontSize: 11, color: C.textMuted, textAlign: 'center', marginTop: 2 },
  divider: { height: 1, backgroundColor: C.divider, marginVertical: 8 },

  // Service row
  svcRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  svcIcon: { width: 42, height: 42, borderRadius: 11, position: 'relative', overflow: 'hidden' },
  svcImg: { position: 'absolute', left: '11%', top: '11%', width: '78%', height: '78%' },
  svcName: { fontFamily: FontFamily.bold, fontSize: 13.5, color: C.white, letterSpacing: -0.1, lineHeight: 16 },
  svcMeta: { fontFamily: FontFamily.medium, fontSize: 11, color: C.textMuted, marginTop: 2 },
  svcPrice: { fontFamily: FontFamily.bold, fontSize: 14, color: C.white },
  removeBtn: {
    width: 28, height: 28, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.dangerSoft,
  },

  // Bill
  billRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  billLabel: { fontFamily: FontFamily.medium, fontSize: 12.5, color: C.textSecondary },
  billValue: { fontFamily: FontFamily.medium, fontSize: 12.5, color: C.textSecondary },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 10, marginTop: 6,
    borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: 'rgba(255,255,255,0.08)',
  },
  totalLabel: { fontFamily: FontFamily.bold, fontSize: 14, color: C.white },
  totalValue: { fontFamily: FontFamily.bold, fontSize: 14, color: C.white },

  // Toggle
  toggleTrack: { width: 46, height: 28, borderRadius: 14, overflow: 'hidden', position: 'relative' },
  toggleOff: { backgroundColor: 'rgba(255,255,255,0.08)' },
  toggleThumb: {
    position: 'absolute', top: 2,
    width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    zIndex: 1,
  },

  // Pay dock
  payDock: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20, paddingTop: 16,
    backgroundColor: 'rgba(10,10,10,0.92)',
    borderTopWidth: 0.5, borderTopColor: C.glassBorderHi,
  },
  payBtnWrap: {
    height: 54, borderRadius: 14, overflow: 'hidden',
    shadowColor: C.amber, shadowOpacity: 0.4, shadowRadius: 30, shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
  payBtnInner: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  payAmt: { fontFamily: FontFamily.extrabold, fontSize: 18, color: C.ink, letterSpacing: -0.4, lineHeight: 20 },
  paySub: { fontFamily: FontFamily.semibold, fontSize: 10.5, color: C.ink, opacity: 0.7, marginTop: 3 },
  payCta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payCtaText: { fontFamily: FontFamily.extrabold, fontSize: 14, color: C.ink, letterSpacing: -0.1 },
});

function FloatingZop() {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(y, { toValue: -10, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(y, { toValue: 0,   duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [y]);
  return (
    <Animated.View style={{ transform: [{ translateY: y }] }}>
      <ZopHappy width={160} height={160} />
    </Animated.View>
  );
}

// PaymentSourcePicker — two-card chooser between Cashfree drop checkout
// ("Pay now") and the closed-loop wallet ("Use wallet"). Wallet card
// disables itself when the loaded balance is below the booking total.
function PaymentSourcePicker({
  selected,
  onChange,
  walletBalanceCents,
  requiredCents,
}: {
  selected: 'direct' | 'wallet';
  onChange: (next: 'direct' | 'wallet') => void;
  walletBalanceCents: number | null;
  requiredCents: number;
}) {
  const balanceKnown = walletBalanceCents != null;
  const sufficient = balanceKnown && walletBalanceCents! >= requiredCents;
  const walletDisabled = !sufficient;

  const walletSubtitle = !balanceKnown
    ? 'Checking balance…'
    : sufficient
    ? `Balance: ₹${(walletBalanceCents! / 100).toFixed(0)}`
    : `Insufficient — ₹${(walletBalanceCents! / 100).toFixed(0)} available, ₹${(requiredCents / 100).toFixed(0)} needed`;

  return (
    <View style={pickerStyles.row}>
      <PaymentSourceCard
        selected={selected === 'direct'}
        title="Pay now"
        subtitle="Cards, UPI, netbanking"
        icons={['credit-card', 'smartphone', 'briefcase']}
        onPress={() => onChange('direct')}
      />
      <PaymentSourceCard
        selected={selected === 'wallet'}
        title="Use wallet"
        subtitle={walletSubtitle}
        icons={['zap']}
        disabled={walletDisabled}
        onPress={() => {
          if (walletDisabled) return;
          onChange('wallet');
        }}
      />
    </View>
  );
}

function PaymentSourceCard({
  selected,
  title,
  subtitle,
  icons,
  disabled,
  onPress,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  icons: Array<keyof typeof Feather.glyphMap>;
  disabled?: boolean;
  onPress: () => void;
}) {
  const tint = disabled ? 'rgba(255,255,255,0.18)' : '#F5A300';
  return (
    <TouchableOpacity
      activeOpacity={disabled ? 1 : 0.85}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityLabel={`${title}. ${subtitle}.`}
      style={[
        pickerStyles.card,
        selected && pickerStyles.cardSelected,
        disabled && pickerStyles.cardDisabled,
      ]}
    >
      <View style={pickerStyles.iconRow}>
        {icons.map((name) => (
          <Feather key={name} name={name} size={14} color={tint} />
        ))}
        {selected ? (
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Feather name="check-circle" size={16} color={tint} />
          </View>
        ) : null}
      </View>
      <Text style={[pickerStyles.title, disabled && { color: 'rgba(255,255,255,0.45)' }]}>
        {title}
      </Text>
      <Text style={pickerStyles.subtitle} numberOfLines={2}>
        {subtitle}
      </Text>
    </TouchableOpacity>
  );
}

const pickerStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  card: {
    flex: 1,
    minHeight: 92,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 6,
  },
  cardSelected: {
    borderColor: 'rgba(245,163,0,0.55)',
    backgroundColor: 'rgba(245,163,0,0.10)',
    shadowColor: '#F5A300',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  cardDisabled: { opacity: 0.55 },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: 14,
    color: '#FFFFFF',
    letterSpacing: -0.1,
  },
  subtitle: {
    fontFamily: FontFamily.medium,
    fontSize: 11.5,
    color: 'rgba(255,255,255,0.6)',
    lineHeight: 15,
  },
});
