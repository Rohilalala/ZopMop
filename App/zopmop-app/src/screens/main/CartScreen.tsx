import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Modal,
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
import { useC } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { BackgroundGlow, ScreenHeader, SectionHeader, Card } from '../../components/screen/ScreenChrome';
import { useCart } from '../../context/CartContext';
import { useAuth } from '../../context/AuthContext';
import { useRoomies } from '../../context/RoomiesContext';
import { listAddresses, type ApiAddress } from '../../api/addresses';
import {
  createScheduledBooking,
  createInstantCartBooking,
  getBookings,
  NoProsAvailableError,
  SlotTooSoonError,
  type EarliestSlot,
} from '../../api/bookings';
import { UnpaidBookingsError } from '../../api/users';
import { getWalletBalance } from '../../api/wallet';
import SchedulingModal, { type ScheduleSelection } from '../../components/SchedulingModal';
import { ModeToggle } from '../../components/ModeToggle';
import { PaymentPicker, planFor } from '../../components/PaymentPicker';
import { LocationSelector } from '../../components/LocationSelector';
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

// "14:30" (IST 24h, as the slots feed sends it) → "2:30 PM" for display.
function prettyTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m ?? 0).padStart(2, '0')} ${period}`;
}

// "Today" if the slot date matches the current IST date, else the short date.
function earliestDayLabel(dateIso: string): string {
  const istToday = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
  return dateIso === istToday ? 'today' : 'tomorrow';
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
  const c = useC();
  const { isDark } = useTheme();

  const [addresses, setAddresses] = useState<ApiAddress[]>(cartMemCache.addresses);
  const [selectedAddress, setSelectedAddress] = useState<ApiAddress | null>(cartMemCache.selectedAddress);
  const [hydrating, setHydrating] = useState(cartMemCache.addresses.length === 0);
  const [addressPickerVisible, setAddressPickerVisible] = useState(false);
  const [schedulingVisible, setSchedulingVisible] = useState(false);
  // Timing lives on the cart's ModeToggle now. 'instant' → ASAP create path
  // (no slot); 'scheduled' → a picked slot drives the scheduled-create path.
  type Timing = 'instant' | 'scheduled';
  const [timing, setTiming] = useState<Timing>('instant');
  const [slot, setSlot] = useState<{ id: string; label: string } | null>(null);
  // Earliest-slot fallback offered when ASAP finds no free pro (409). Drives an
  // inline "book it instead" sheet.
  const [noProsEarliest, setNoProsEarliest] = useState<EarliestSlot | null>(null);
  const [booking, setBooking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const bookingInFlight = useRef(false);

  const [splitEnabled, setSplitEnabled] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  // Payment picker state — wallet applicator + when (pay now / pay after).
  // `planFor` collapses these into the funding rail mapped onto payment_source.
  const [useWallet, setUseWallet] = useState(false);
  const [payWhen, setPayWhen] = useState<'now' | 'after'>('now');
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

  // Resolved funding rail from the picker. Drives the payment_source mapping in
  // checkout and gates the Roomies split (no split under pay-after, D-edge).
  const plan = planFor(useWallet, payWhen, totalCents, walletBalance);
  const splitAllowed = plan.kind !== 'pay_after';

  // Pay-after can't be bill-split — force the toggle off when it's selected.
  useEffect(() => {
    if (plan.kind === 'pay_after') setSplitEnabled(false);
  }, [plan.kind]);

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
        price_paise: removed?.price_paise ?? null,
      });
    } finally { setRemoving(null); }
  }, [removeItem, items, posthog]);

  const handleCheckout = useCallback(async (slotOverride?: string) => {
    if (!token) return;
    if (!selectedAddress) { showError('Please select a delivery address.', { title: 'No address' }); return; }
    // Instant needs no slot; a scheduled booking needs one. slotOverride is set
    // by the "book the earliest slot instead" tap from the no-pros sheet — that
    // path is always a scheduled create.
    const slotId = slotOverride ?? slot?.id;
    const isAsap = timing === 'instant' && !slotOverride;
    if (timing === 'scheduled' && !slot && !slotOverride) {
      showError('Please pick a date and time slot.', { title: 'No time selected' });
      return;
    }
    if (itemCount === 0) return;
    if (bookingInFlight.current) return;

    // Resolve the funding rail. Wallet (full/split) debits inline; cod is
    // pay-after; direct hands off to Cashfree.
    const plan = planFor(useWallet, payWhen, totalCents, walletBalance);
    const applied = Math.min(walletBalance ?? 0, totalCents);
    const paymentSource = ({ wallet_full: 'wallet', wallet_split: 'split', online: 'direct', pay_after: 'cod' } as const)[plan.kind];

    // Wallet pre-flight: defense in depth. Only a full-wallet pay needs the
    // balance to cover the total — split uses whatever is there and tops up
    // online, so it never blocks on balance.
    if (plan.kind === 'wallet_full') {
      if (walletBalance == null || walletBalance < totalCents) {
        showError('Insufficient wallet balance.', { title: 'Top up first' });
        return;
      }
    }

    haptics.medium();

    posthog.capture('booking_checkout_started', {
      item_count: itemCount,
      subtotal_paise: subtotalCents,
      total_paise: totalCents,
      payment_source: paymentSource,
      has_promo: !!promoStore.get(),
      split_enabled: splitEnabled,
    });

    const doSplit = splitEnabled && !!myGroup && selectedMemberIds.size > 0;

    bookingInFlight.current = true;
    setBooking(true);
    setNoProsEarliest(null);
    const promoCode = promoStore.get() ?? undefined;
    // ASAP assignment outcome — passed to the confirmation screen so it can
    // render the "<Name> is on the way — arriving by <now + eta>" promise
    // (Task 2 owns the rendering; here we just thread the values through).
    let asapAssigned = false;
    let asapHelperName: string | undefined;
    let asapEtaMinutes: number | undefined;
    try {
      let created;
      if (isAsap) {
        const asap = await createInstantCartBooking(token, {
          address_id: selectedAddress.id,
          ...(promoCode ? { promo_code: promoCode } : {}),
          payment_source: paymentSource,
          ...(plan.kind === 'wallet_split' ? { wallet_apply_paise: applied } : {}),
        });
        created = asap.booking;
        asapAssigned = asap.assigned;
        asapHelperName = asap.helper_name || undefined;
        asapEtaMinutes = asap.promise_eta_minutes;
      } else {
        created = await createScheduledBooking(token, {
          address_id: selectedAddress.id,
          time_slot_id: slotId!,
          ...(promoCode ? { promo_code: promoCode } : {}),
          payment_source: paymentSource,
          ...(plan.kind === 'wallet_split' ? { wallet_apply_paise: applied } : {}),
        });
      }

      posthog.capture('booking_confirmed', {
        booking_id: created.id,
        total_paise: totalCents,
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

      if (plan.kind === 'online' || plan.kind === 'wallet_split') {
        // Online (full) or wallet-split (remainder): booking exists with an
        // amount still due online. Hand off to the Cashfree drop sheet flow —
        // PaymentScreen owns order creation + SDK launch. For split, the wallet
        // portion was debited inline; charge only the remainder.
        const amountDue = plan.kind === 'wallet_split' ? created.price_paise - applied : created.price_paise;
        posthog.capture('booking_payment_initiated', {
          booking_id: created.id,
          amount_paise: amountDue,
        });
        navigation.replace('Payment', {
          booking_id: created.id,
          // JSON field is back-compat; value is paise (see backend
          // migration 065). No * 100 conversion needed.
          amount_paise: amountDue,
          bookingType: isAsap ? 'instant' : 'scheduled',
          // Thread the ASAP arrival promise so PaymentScreen can pass it on to
          // BookingConfirmed — card/UPI ASAP renders "arriving by HH:MM" too.
          ...(isAsap && asapAssigned
            ? { helperName: asapHelperName, etaMinutes: asapEtaMinutes }
            : {}),
        });
        return;
      }

      // plan.kind === 'wallet_full' (debited inline) or 'pay_after' (cod,
      // assigned immediately): nothing more to charge now. Go straight to the
      // confirmation screen.
      navigation.replace('BookingConfirmed', {
        bookingId: created.id,
        totalCents,
        bookingType: isAsap ? 'instant' : 'scheduled',
        slot: isAsap ? undefined : slot?.label ?? undefined,
        addressLine: selectedAddress.full_address ?? selectedAddress.title ?? undefined,
        // ASAP arrival promise — the confirmation screen turns these into
        // "<Name> is on the way — arriving by <now + eta>" (spec §6).
        ...(isAsap && asapAssigned
          ? { helperName: asapHelperName, etaMinutes: asapEtaMinutes }
          : {}),
      });
    } catch (err: any) {
      if (err instanceof NoProsAvailableError) {
        // ASAP found no free pro right now. The booking row was already
        // cancelled server-side. Offer the earliest bookable regular slot in an
        // inline sheet (one-tap rebooks via the scheduled path); if none is
        // free today/tomorrow, just tell the customer to try again shortly.
        if (err.earliest) {
          setNoProsEarliest(err.earliest);
        } else {
          showError(
            'No pros are free right now and no later slot is open today. Please try again in a few minutes.',
            { title: 'No pros available' },
          );
        }
        return;
      }

      if (err instanceof SlotTooSoonError) {
        // The chosen slot is inside the 45-min lead window (race past the
        // picker's own disable). Nudge to ASAP.
        showError('Slots open 45 minutes out — use ASAP for now.', { title: 'Too soon' });
        return;
      }

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

      if ((paymentSource === 'wallet' || paymentSource === 'split') && code === 'INSUFFICIENT_WALLET_BALANCE') {
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
    token, selectedAddress, timing, slot, itemCount, refreshCart, navigation,
    splitEnabled, myGroup, selectedMemberIds, totalCents, splitCount, bookGroupChore,
    useWallet, payWhen, walletBalance, refetchWalletBalance, subtotalCents, posthog,
  ]);

  if (hydrating) {
    return (
      <View style={[s.root, { backgroundColor: c.bg }]}>
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
      <View style={[s.root, { backgroundColor: c.bg }]}>
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
            onCtaPress={() => navigation.navigate('Tabs', { screen: 'AllServices' })}
            style={{ flex: 1 }}
          />
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={[s.root, { backgroundColor: c.bg }]}>
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
                <View style={[s.addrPin, { backgroundColor: c.amberSoft }]}>
                  <Feather name="map-pin" size={16} color={c.amber} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {selectedAddress ? (
                    <>
                      <Text style={[s.addrTitle, { color: c.text }]}>{selectedAddress.title || selectedAddress.tag}</Text>
                      <Text style={[s.addrSub, { color: c.textMuted }]} numberOfLines={2}>{selectedAddress.full_address}</Text>
                    </>
                  ) : (
                    <Text style={[s.addrTitle, { color: c.text }]}>Add delivery address</Text>
                  )}
                </View>
                <Text style={[s.changeLink, { color: c.amber }]}>{selectedAddress ? 'Change' : 'Add'}</Text>
              </View>
            </Card>
          </TouchableOpacity>

          {isRoomiesAddress && splitAllowed && (
            <>
              <SectionHeader>Roomies split</SectionHeader>
              <Card>
                <View style={s.splitHeader}>
                  <View style={[s.splitIcon, { backgroundColor: c.amberSoft }]}>
                    <Feather name="home" size={16} color={c.amber} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[s.splitTitle, { color: c.text }]}>Split with Roomies</Text>
                    <Text style={[s.splitMeta, { color: c.textMuted }]}>
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
                      <Text style={[s.splitNote, { color: c.textMuted }]}>You're the only member in this group. Invite roomies to split costs.</Text>
                    ) : (
                      <>
                        <View style={[s.divider, { backgroundColor: c.divider }]} />
                        {otherMembers.map((member, i) => {
                          const sel = selectedMemberIds.has(member.user_id);
                          const isHost = member.role === 'host';
                          return (
                            <TouchableOpacity
                              key={member.user_id}
                              activeOpacity={0.8}
                              onPress={() => toggleMember(member.user_id)}
                              style={[s.memberRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider }]}
                            >
                              <View style={[s.memberAvatar, { backgroundColor: c.amberSoft }]}>
                                <Feather name={isHost ? 'star' : 'user'} size={14} color={c.amber} />
                              </View>
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={[s.memberName, { color: c.text }]}>{isHost ? 'Host' : `Roomie ${i + 1}`}</Text>
                                <Text style={[s.memberMeta, { color: c.textMuted }]}>
                                  {member.prepaid_balance > 0
                                    ? `Vault ₹${(member.prepaid_balance / 100).toFixed(0)}`
                                    : 'No vault balance'}
                                </Text>
                              </View>
                              <View style={[s.checkbox, { borderColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(13,13,15,0.15)' }, sel && s.checkboxOn]}>
                                {sel && <Feather name="check" size={12} color={c.ink} />}
                              </View>
                            </TouchableOpacity>
                          );
                        })}

                        <View style={[s.splitSummary, { backgroundColor: isDark ? 'rgba(245,163,0,0.06)' : 'rgba(245,163,0,0.06)' }]}>
                          <View style={s.splitRow}>
                            <Text style={[s.splitKey, { color: c.textMuted }]}>Total order</Text>
                            <Text style={[s.splitVal, { color: c.text }]}>₹{(totalCents / 100).toFixed(0)}</Text>
                          </View>
                          <View style={s.splitRow}>
                            <Text style={[s.splitKey, { color: c.textMuted }]}>Split between</Text>
                            <Text style={[s.splitVal, { color: c.text }]}>{splitCount} people</Text>
                          </View>
                          {selectedMemberIds.size > 0 ? (
                            <>
                              <View style={[s.splitDashed, { borderTopColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(13,13,15,0.08)' }]} />
                              <View style={s.splitRow}>
                                <Text style={[s.splitTotalKey, { color: c.text }]}>Your share</Text>
                                <Text style={[s.splitTotalVal, { color: c.amber }]}>₹{(myShareCents / 100).toFixed(0)}</Text>
                              </View>
                            </>
                          ) : (
                            <Text style={[s.splitNote, { color: c.textMuted, textAlign: 'left', marginTop: 4 }]}>
                              Select at least one roomie to split costs.
                            </Text>
                          )}
                        </View>
                        <Text style={[s.splitNote, { color: c.textMuted }]}>
                          Roomies pay from Vault balance. Shortfalls become tracked debts.
                        </Text>
                      </>
                    )}
                  </>
                )}
              </Card>
            </>
          )}

          <SectionHeader>When</SectionHeader>
          {itemCount > 0 && (
            <ModeToggle
              mode={timing === 'instant' ? 'instant' : 'schedule'}
              onChange={(m) => {
                setTiming(m === 'instant' ? 'instant' : 'scheduled');
                if (m === 'instant') setSlot(null);
                else setSchedulingVisible(true); // open slot picker for scheduled
              }}
            />
          )}
          {timing === 'scheduled' && (
            <TouchableOpacity activeOpacity={0.85} onPress={() => setSchedulingVisible(true)} style={{ marginTop: 12 }}>
              <Card>
                <View style={s.addrRow}>
                  <View style={[s.addrPin, { backgroundColor: c.amberSoft }]}>
                    <Feather name="calendar" size={16} color={c.amber} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    {slot?.label ? (
                      <>
                        <Text style={[s.addrTitle, { color: c.text }]}>{slot.label}</Text>
                        <Text style={[s.addrSub, { color: c.textMuted }]}>Tap to change</Text>
                      </>
                    ) : (
                      <>
                        <Text style={[s.addrTitle, { color: c.text }]}>Pick a date & time</Text>
                        <Text style={[s.addrSub, { color: c.textMuted }]}>Required to confirm booking</Text>
                      </>
                    )}
                  </View>
                  <Text style={[s.changeLink, { color: c.amber }]}>{slot?.label ? 'Change' : 'Select'}</Text>
                </View>
              </Card>
            </TouchableOpacity>
          )}

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
                            <Stop offset="0%" stopColor={isDark ? '#1A1A1C' : '#F5F0E8'} />
                            <Stop offset="100%" stopColor={isDark ? '#0F0F11' : '#EDE7DB'} />
                          </SvgLinearGradient>
                          <SvgRadialGradient id={`svcTop-${item.id}`} cx="50%" cy="18%" rx="120%" ry="90%">
                            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity={isDark ? '0.10' : '0.60'} />
                            <Stop offset="60%" stopColor="#FFFFFF" stopOpacity="0" />
                          </SvgRadialGradient>
                          <SvgRadialGradient id={`svcBot-${item.id}`} cx="50%" cy="110%" rx="80%" ry="60%">
                            <Stop offset="0%" stopColor="#F5A300" stopOpacity={isDark ? '0.16' : '0.12'} />
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
                      <Text style={[s.svcName, { color: c.text }]} numberOfLines={1}>{item.service_name}</Text>
                      <Text style={[s.svcMeta, { color: c.textMuted }]}>{item.duration_minutes} min</Text>
                    </View>
                    <View style={s.qtyRow}>
                      <TouchableOpacity
                        onPress={() => handleRemove(item.id)}
                        activeOpacity={0.7}
                        disabled={removing === item.id}
                        style={[s.qtyBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(13,13,15,0.05)' }]}
                        hitSlop={8}
                      >
                        {removing === item.id
                          ? <LoadingBars size="small" color={c.textMuted} />
                          : <Feather name="minus" size={12} color={c.textMuted} />}
                      </TouchableOpacity>
                      <Text style={[s.qtyCount, { color: c.text }]}>1</Text>
                      <TouchableOpacity
                        onPress={() => navigation.navigate('Tabs', { screen: 'AllServices' })}
                        activeOpacity={0.7}
                        style={[s.qtyBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(13,13,15,0.05)' }]}
                        hitSlop={8}
                      >
                        <Feather name="plus" size={12} color={c.amber} />
                      </TouchableOpacity>
                    </View>
                    <Text style={[s.svcPrice, { color: c.text }]}>₹{(item.price_paise / 100).toFixed(0)}</Text>
                  </View>
                  {i < items.length - 1 && <View style={[s.divider, { backgroundColor: c.divider }]} />}
                </ReAnimated.View>
              );
            })}
          </Card>

          <SectionHeader>Bill details</SectionHeader>
          <Card>
            <BillRow label="Subtotal" value={`₹${(subtotalCents / 100).toFixed(0)}`} />
            <BillRow label="Platform fee" value={`₹${(feeCents / 100).toFixed(0)}`} />
            <View style={[s.totalRow, { borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.08)' }]}>
              <Text style={[s.totalLabel, { color: c.text }]}>Total to pay</Text>
              <Text style={[s.totalValue, { color: c.text }]}>₹{(totalCents / 100).toFixed(0)}</Text>
            </View>
          </Card>

          <SectionHeader>Pay with</SectionHeader>
          <PaymentPicker
            totalPaise={totalCents}
            walletBalancePaise={walletBalance}
            value={{ useWallet, payWhen }}
            onChange={(v) => { setUseWallet(v.useWallet); setPayWhen(v.payWhen); }}
          />
        </ScrollView>

        <View style={[s.payDock, { paddingBottom: 16 + insets.bottom, backgroundColor: isDark ? 'rgba(10,10,10,0.92)' : 'rgba(255,255,255,0.95)', borderTopColor: isDark ? c.glassBorderHi : 'rgba(13,13,15,0.06)' }]}>
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
        addressId={selectedAddress?.id}
        onClose={() => setSchedulingVisible(false)}
        onConfirm={(sel: ScheduleSelection) => {
          setTiming('scheduled');
          setSlot({ id: sel.slotId, label: sel.label });
          setSchedulingVisible(false);
        }}
      />

      <Modal
        visible={!!noProsEarliest}
        transparent
        animationType="fade"
        onRequestClose={() => setNoProsEarliest(null)}
      >
        <View style={s.sheetOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFillObject}
            activeOpacity={1}
            onPress={() => setNoProsEarliest(null)}
          />
          <View style={[s.noProsSheet, { backgroundColor: c.bg, borderColor: c.glassBorderHi }]}>
            <View style={[s.noProsIcon, { backgroundColor: c.amberSoft }]}>
              <Feather name="clock" size={20} color={c.amber} />
            </View>
            <Text style={[s.noProsTitle, { color: c.text }]}>No pros free right now</Text>
            {noProsEarliest && (
              <Text style={[s.noProsBody, { color: c.textMuted }]}>
                The earliest slot is {prettyTime(noProsEarliest.start_time)} {earliestDayLabel(noProsEarliest.date)}. Book it?
              </Text>
            )}
            <PrimaryButton
              label={
                noProsEarliest
                  ? `Book ${prettyTime(noProsEarliest.start_time)} ${earliestDayLabel(noProsEarliest.date)}`
                  : 'Book earliest slot'
              }
              onPress={() => {
                const earliest = noProsEarliest;
                if (!earliest) return;
                setNoProsEarliest(null);
                setTiming('scheduled');
                setSlot({
                  id: earliest.slot_id,
                  label: `${prettyTime(earliest.start_time)} – ${prettyTime(earliest.end_time)}`,
                });
                handleCheckout(earliest.slot_id);
              }}
              showChevron
            />
            <TouchableOpacity
              style={s.noProsCancel}
              activeOpacity={0.7}
              onPress={() => setNoProsEarliest(null)}
            >
              <Text style={[s.noProsCancelText, { color: c.textMuted }]}>Not now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <LocationSelector
        visible={addressPickerVisible}
        onClose={() => setAddressPickerVisible(false)}
        mode={{ kind: 'select', initialAddressId: selectedAddress?.id }}
        theme={isDark ? 'dark' : 'light'}
        onLocationSelect={(_name, _lat, _lon, _addrId, address) => {
          if (address) {
            setSelectedAddress(address);
            setAddresses((prev) => {
              const exists = prev.find((a) => a.id === address.id);
              if (exists) return prev.map((a) => a.id === address.id ? address : a);
              return [address, ...prev];
            });
          }
        }}
        onAddressesChanged={async () => {
          if (!token) return;
          try {
            const list = await listAddresses(token);
            setAddresses(list);
            if (selectedAddress && !list.find((a) => a.id === selectedAddress.id)) {
              setSelectedAddress(list[0] ?? null);
            }
          } catch {}
        }}
      />
    </View>
  );
}

function BillRow({ label, value }: { label: string; value: string }) {
  const c = useC();
  return (
    <View style={s.billRow}>
      <Text style={[s.billLabel, { color: c.textSecondary }]}>{label}</Text>
      <Text style={[s.billValue, { color: c.textSecondary }]}>{value}</Text>
    </View>
  );
}

function DarkToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const c = useC();
  const { isDark } = useTheme();
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
      <View style={[s.toggleTrack, on ? null : { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.08)' }]}>
        {on && (
          <View style={StyleSheet.absoluteFill}>
            <Svg width="46" height="28">
              <Defs>
                <SvgLinearGradient id="togGrad" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%" stopColor={c.amberHi} />
                  <Stop offset="100%" stopColor={c.amber} />
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
  root: { flex: 1 },

  // Empty state
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 14 },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },
  emptyTitle: { fontFamily: FontFamily.bold, fontSize: 20, letterSpacing: -0.4 },
  emptySub: { fontFamily: FontFamily.medium, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  browseBtn: {
    marginTop: 12, height: 50, paddingHorizontal: 28, borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  browseBtnText: { fontFamily: FontFamily.extrabold, fontSize: 14, letterSpacing: 0.2 },

  // Address row + schedule row
  addrRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  addrPin: {
    width: 36, height: 36, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  addrTitle: { fontFamily: FontFamily.bold, fontSize: 14, letterSpacing: -0.1 },
  addrSub: { fontFamily: FontFamily.medium, fontSize: 11.5, marginTop: 2, lineHeight: 15 },
  changeLink: { fontFamily: FontFamily.bold, fontSize: 11.5, letterSpacing: 0.2 },

  // Roomies split
  splitHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  splitIcon: {
    width: 36, height: 36, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  splitTitle: { fontFamily: FontFamily.bold, fontSize: 14, letterSpacing: -0.1 },
  splitMeta: { fontFamily: FontFamily.medium, fontSize: 11.5, marginTop: 2 },
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12,
  },
  memberAvatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  memberName: { fontFamily: FontFamily.semibold, fontSize: 13, letterSpacing: -0.05 },
  memberMeta: { fontFamily: FontFamily.medium, fontSize: 11, marginTop: 1 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: '#F5A300', borderColor: '#F5A300' },
  splitSummary: {
    marginTop: 4,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  splitKey: { fontFamily: FontFamily.medium, fontSize: 12 },
  splitVal: { fontFamily: FontFamily.semibold, fontSize: 12 },
  splitDashed: {
    height: 1, marginVertical: 4,
    borderTopWidth: 1, borderStyle: 'dashed',
  },
  splitTotalKey: { fontFamily: FontFamily.bold, fontSize: 13 },
  splitTotalVal: { fontFamily: FontFamily.bold, fontSize: 13 },
  splitNote: { fontFamily: FontFamily.medium, fontSize: 11, textAlign: 'center', marginTop: 2 },
  divider: { height: 1, marginVertical: 8 },

  // Service row
  svcRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  svcIcon: { width: 42, height: 42, borderRadius: 11, position: 'relative', overflow: 'hidden' },
  svcImg: { position: 'absolute', left: '11%', top: '11%', width: '78%', height: '78%' },
  svcName: { fontFamily: FontFamily.bold, fontSize: 13.5, letterSpacing: -0.1, lineHeight: 16 },
  svcMeta: { fontFamily: FontFamily.medium, fontSize: 11, marginTop: 2 },
  svcPrice: { fontFamily: FontFamily.bold, fontSize: 14 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  qtyBtn: {
    width: 26, height: 26, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  qtyCount: { fontFamily: FontFamily.bold, fontSize: 13, minWidth: 16, textAlign: 'center' },

  // Bill
  billRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  billLabel: { fontFamily: FontFamily.medium, fontSize: 12.5 },
  billValue: { fontFamily: FontFamily.medium, fontSize: 12.5 },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 10, marginTop: 6,
    borderTopWidth: 1, borderStyle: 'dashed',
  },
  totalLabel: { fontFamily: FontFamily.bold, fontSize: 14 },
  totalValue: { fontFamily: FontFamily.bold, fontSize: 14 },

  // Toggle
  toggleTrack: { width: 46, height: 28, borderRadius: 14, overflow: 'hidden', position: 'relative' },
  toggleThumb: {
    position: 'absolute', top: 2,
    width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    zIndex: 1,
  },

  // No-pros-available sheet (ASAP fallback)
  sheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  noProsSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 0.5,
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 34,
    alignItems: 'center',
    gap: 10,
  },
  noProsIcon: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  noProsTitle: { fontFamily: FontFamily.extrabold, fontSize: 18, letterSpacing: -0.3 },
  noProsBody: { fontFamily: FontFamily.medium, fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 8 },
  noProsCancel: { paddingVertical: 8, marginTop: 2 },
  noProsCancelText: { fontFamily: FontFamily.semibold, fontSize: 13 },

  // Pay dock
  payDock: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20, paddingTop: 16,
    borderTopWidth: 0.5,
  },
  payBtnWrap: {
    height: 54, borderRadius: 14, overflow: 'hidden',
    shadowColor: '#F5A300', shadowOpacity: 0.4, shadowRadius: 30, shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
  payBtnInner: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  payAmt: { fontFamily: FontFamily.extrabold, fontSize: 18, color: '#0D0D0F', letterSpacing: -0.4, lineHeight: 20 },
  paySub: { fontFamily: FontFamily.semibold, fontSize: 10.5, color: '#0D0D0F', opacity: 0.7, marginTop: 3 },
  payCta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payCtaText: { fontFamily: FontFamily.extrabold, fontSize: 14, color: '#0D0D0F', letterSpacing: -0.1 },
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
