import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useCart } from '../../context/CartContext';
import { useAuth } from '../../context/AuthContext';
import { listAddresses, type ApiAddress } from '../../api/addresses';
import { createScheduledBooking, getBookings } from '../../api/bookings';
import SchedulingModal from '../../components/SchedulingModal';
import AddressPickerModal from '../../components/AddressPickerModal';
import * as Location from 'expo-location';

type Nav = NativeStackNavigationProp<MainStackParamList>;

const PLATFORM_FEE_CENTS = 2000; // ₹20

export default function CartScreen() {
  const navigation = useNavigation<Nav>();
  const { items, itemCount, subtotalCents, removeItem, refreshCart } = useCart();
  const { token } = useAuth();

  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<ApiAddress | null>(null);
  const [addressPickerVisible, setAddressPickerVisible] = useState(false);
  const [schedulingVisible, setSchedulingVisible] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedSlotLabel, setSelectedSlotLabel] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function loadAddresses() {
    if (!token) return;
    try {
      const list = await listAddresses(token);
      setAddresses(list);
      if (list.length === 0) return;

      // 1. Try to match current GPS to nearest saved address
      let picked: ApiAddress | null = null;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          const { latitude, longitude } = pos.coords;
          // Find closest saved address by Euclidean distance on lat/lon
          let minDist = Infinity;
          for (const addr of list) {
            const d = Math.hypot(addr.lat - latitude, addr.lon - longitude);
            if (d < minDist) { minDist = d; picked = addr; }
          }
          // Only auto-select if within ~1 km (≈0.009 degrees)
          if (minDist > 0.009) picked = null;
        }
      } catch { /* location unavailable */ }

      // 2. Fall back to address used in last order
      if (!picked) {
        try {
          const past = await getBookings(token, 'past', 1);
          if (past.length > 0 && past[0].address_id) {
            picked = list.find(a => a.id === past[0].address_id) ?? null;
          }
        } catch { /* no past bookings */ }
      }

      // 3. Fall back to first saved address
      setSelectedAddress(picked ?? list[0]);
    } catch { /* ignore */ }
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

  const feeCents = PLATFORM_FEE_CENTS;
  const totalCents = subtotalCents + feeCents;

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

    setBooking(true);
    try {
      await createScheduledBooking(token, {
        address_id: selectedAddress.id,
        time_slot_id: selectedSlotId,
      });
      await refreshCart();
      Alert.alert('Booking Confirmed! 🎉', 'Your service has been scheduled.', [
        { text: 'View Bookings', onPress: () => navigation.navigate('Bookings') },
      ]);
    } catch (err: any) {
      Alert.alert('Booking Failed', err?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setBooking(false);
    }
  }, [token, selectedAddress, selectedSlotId, itemCount, refreshCart, navigation]);

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

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Address */}
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

        {/* Schedule */}
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

        {/* Services */}
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
                    ? <ActivityIndicator size="small" color={Colors.danger} />
                    : <Text style={s.removeBtnText}>✕</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>

        {/* Price Summary */}
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

      {/* Sticky Pay Now */}
      <View style={s.bottomBar}>
        <View style={s.totalInfo}>
          <Text style={s.totalInfoLabel}>Total</Text>
          <Text style={s.totalInfoValue}>₹{(totalCents / 100).toFixed(0)}</Text>
        </View>
        <TouchableOpacity
          style={[s.payBtn, booking && s.payBtnDisabled]}
          activeOpacity={0.85}
          disabled={booking}
          onPress={handleCheckout}
        >
          {booking
            ? <ActivityIndicator color={Colors.white} />
            : <Text style={s.payBtnText}>Pay Now</Text>
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
              // Select the address closest to where the user just dropped the pin
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

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 12 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: Radius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  backIcon: { fontSize: 18, color: Colors.text, marginTop: -1 },
  headerTitle: {
    flex: 1, textAlign: 'center',
    fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: Colors.text,
  },

  // Card
  card: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
    gap: 8,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardLabel: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.text },
  editLink: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.primary },

  // Address
  addressTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: Colors.text },
  addressFull: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary },
  addAddressText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.primary, paddingVertical: 4 },

  // Schedule
  slotLabel: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.primary },
  slotPlaceholder: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textMuted },

  // Services
  serviceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  serviceRowBorder: { borderTopWidth: 1, borderTopColor: Colors.border },
  serviceLeft: { flex: 1 },
  serviceName: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.text },
  serviceDuration: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },
  serviceRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  servicePrice: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: Colors.text },
  removeBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  removeBtnText: { fontSize: 14, color: Colors.danger, fontFamily: FontFamily.semibold },

  // Price
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  priceKey: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary },
  priceVal: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: Colors.text },
  totalRow: { borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 6, paddingTop: 10 },
  totalKey: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: Colors.text },
  totalVal: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: Colors.primary },

  // Empty state
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  emptyEmoji: { fontSize: 56, marginBottom: 4 },
  emptyTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: Colors.text },
  emptySub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  browseBtn: {
    marginTop: 8, backgroundColor: Colors.primary,
    paddingHorizontal: 28, paddingVertical: 12, borderRadius: Radius.xl, ...Shadow.sm,
  },
  browseBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.white },

  // Bottom
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: Colors.white,
    borderTopWidth: 1, borderTopColor: Colors.border,
    gap: 16,
    ...Shadow.md,
  },
  totalInfo: { flex: 1 },
  totalInfoLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted },
  totalInfoValue: { fontFamily: FontFamily.bold, fontSize: FontSize.xl, color: Colors.text },
  payBtn: {
    flex: 1, backgroundColor: Colors.primary,
    borderRadius: Radius.xl, paddingVertical: 14,
    alignItems: 'center', ...Shadow.sm,
  },
  payBtnDisabled: { opacity: 0.6 },
  payBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.white },
});
