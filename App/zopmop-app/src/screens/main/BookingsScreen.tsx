import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { lightColors, Colors } from '../../theme/colors';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { getBookings, cancelBooking, type ApiBooking, type BookingStatus } from '../../api/bookings';
import { useAuth } from '../../context/AuthContext';

type Tab = 'upcoming' | 'past';
type C = typeof lightColors;

function createStyles(c: C) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 4 },
    backBtn: { padding: 4, marginLeft: -4 },
    headerTitle: { fontFamily: FontFamily.bold, fontSize: FontSize['2xl'], color: c.text, letterSpacing: -0.5 },
    tabBar: {
      flexDirection: 'row',
      borderBottomWidth: 1, borderBottomColor: c.border,
      paddingHorizontal: 16,
      backgroundColor: c.white,
    },
    tab: { paddingVertical: 12, marginRight: 24, borderBottomWidth: 2, borderBottomColor: 'transparent' },
    tabActive: { borderBottomColor: c.primary },
    tabText: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: c.textSecondary },
    tabTextActive: { color: c.primary },
    scroll: { flex: 1 },
    scrollContent: { padding: 16, gap: 12 },
    scrollEmpty: { flexGrow: 1 },
    card: {
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      padding: 16,
      borderWidth: 1, borderColor: c.border,
      ...Shadow.sm,
      gap: 8,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    statusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.full },
    statusText: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs },
    bookingDate: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },
    serviceNames: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text },
    serviceMeta: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    serviceList: { backgroundColor: c.surface, borderRadius: Radius.lg, padding: 10, gap: 6 },
    serviceItem: { flexDirection: 'row', justifyContent: 'space-between' },
    serviceItemName: { fontFamily: FontFamily.medium, fontSize: FontSize.xs, color: c.text },
    serviceItemDetail: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },
    trackBtn: { backgroundColor: c.primary, borderRadius: Radius.lg, paddingVertical: 8, alignItems: 'center', marginTop: 4 },
    trackBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: '#FFFFFF' },
    cancelBtn: { borderWidth: 1, borderColor: c.danger, borderRadius: Radius.lg, paddingVertical: 8, alignItems: 'center', marginTop: 4 },
    cancelBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.danger },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 48, gap: 10 },
    emptyIconWrap: { width: 80, height: 80, borderRadius: Radius.full, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 6, borderWidth: 1, borderColor: c.border },
    emptyEmoji: { fontSize: 36 },
    emptyTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    emptySub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, textAlign: 'center', maxWidth: 220, lineHeight: 20 },
  });
}

export default function BookingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const [tab, setTab] = useState<Tab>('upcoming');
  const [bookings, setBookings] = useState<ApiBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBookings = useCallback(async (isRefresh = false) => {
    if (!token) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await getBookings(token, tab);
      setBookings(data);
    } catch {
      setBookings([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, tab]);

  useEffect(() => {
    setBookings([]);
    fetchBookings();
  }, [fetchBookings]);

  const handleTrack = useCallback((booking: ApiBooking) => {
    navigation.navigate('ActiveBooking', {
      bookingId: booking.id,
      serviceName: booking.services?.[0]?.service_name ?? 'Service',
      helperName: booking.helper_name ?? 'Your Pro',
      helperRating: booking.helper_rating ?? 5,
      helperLat: booking.helper_lat,
      helperLng: booking.helper_lng,
      etaMinutes: 0,
    });
  }, [navigation]);

  const handleCancel = useCallback(async (bookingId: string) => {
    if (!token) return;
    Alert.alert('Cancel Booking', 'Are you sure you want to cancel this booking?', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel Booking', style: 'destructive',
        onPress: async () => {
          try {
            await cancelBooking(token, bookingId);
            fetchBookings();
          } catch (err: any) {
            Alert.alert('Error', err?.message ?? 'Could not cancel booking.');
          }
        },
      },
    ]);
  }, [token, fetchBookings]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Your Bookings</Text>
      </View>

      {/* Tab bar */}
      <View style={s.tabBar}>
        {(['upcoming', 'past'] as Tab[]).map(t => (
          <TouchableOpacity
            key={t}
            style={[s.tab, tab === t && s.tabActive]}
            onPress={() => setTab(t)}
            activeOpacity={0.7}
          >
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginTop: 48 }} />
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={[s.scrollContent, bookings.length === 0 && s.scrollEmpty]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchBookings(true)}
              tintColor={c.primary}
            />
          }
        >
          {bookings.length === 0 ? (
            <EmptyState tab={tab} />
          ) : (
            bookings.map(booking => (
              <BookingCard
                key={booking.id}
                booking={booking}
                onCancel={tab === 'upcoming' ? handleCancel : undefined}
                onTrack={(booking.status === 'accepted' || booking.status === 'in_progress') ? handleTrack : undefined}
              />
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Booking Card ──────────────────────────────────────────────────────────────

function BookingCard({
  booking,
  onCancel,
  onTrack,
}: {
  booking: ApiBooking;
  onCancel?: (id: string) => void;
  onTrack?: (booking: ApiBooking) => void;
}) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const statusMeta = getStatusMeta(c)[booking.status] ?? getStatusMeta(c).pending;
  const serviceNames = booking.services?.length
    ? booking.services.map(s => s.service_name).join(', ')
    : 'Service';
  const totalDuration = booking.total_duration_minutes;
  const totalPrice = (booking.price_cents / 100).toFixed(0);

  return (
    <View style={s.card}>
      {/* Status badge */}
      <View style={s.cardHeader}>
        <View style={[s.statusBadge, { backgroundColor: statusMeta.bg }]}>
          <Text style={[s.statusText, { color: statusMeta.color }]}>
            {statusMeta.icon} {statusMeta.label}
          </Text>
        </View>
        <Text style={s.bookingDate}>{formatDate(booking.scheduled_time ?? booking.created_at)}</Text>
      </View>

      {/* Services */}
      <Text style={s.serviceNames} numberOfLines={2}>{serviceNames}</Text>
      <Text style={s.serviceMeta}>{totalDuration} min total · ₹{totalPrice}</Text>

      {/* Individual services */}
      {booking.services?.length > 0 && (
        <View style={s.serviceList}>
          {booking.services.map((svc, i) => (
            <View key={i} style={s.serviceItem}>
              <Text style={s.serviceItemName}>{svc.service_name}</Text>
              <Text style={s.serviceItemDetail}>{svc.duration_minutes} min · ₹{(svc.price_cents / 100).toFixed(0)}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Actions */}
      {onTrack && (
        <TouchableOpacity
          style={s.trackBtn}
          activeOpacity={0.8}
          onPress={() => onTrack(booking)}
        >
          <Text style={s.trackBtnText}>Track Booking →</Text>
        </TouchableOpacity>
      )}
      {onCancel && (booking.status === 'pending' || booking.status === 'accepted') && (
        <TouchableOpacity
          style={s.cancelBtn}
          activeOpacity={0.7}
          onPress={() => onCancel(booking.id)}
        >
          <Text style={s.cancelBtnText}>Cancel Booking</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────

function EmptyState({ tab }: { tab: Tab }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const isUpcoming = tab === 'upcoming';
  return (
    <View style={s.empty}>
      <View style={s.emptyIconWrap}>
        <Text style={s.emptyEmoji}>{isUpcoming ? '📅' : '✅'}</Text>
      </View>
      <Text style={s.emptyTitle}>{isUpcoming ? 'No upcoming bookings' : 'No past bookings'}</Text>
      <Text style={s.emptySub}>
        {isUpcoming
          ? 'Your scheduled services will appear here'
          : 'Your completed services will appear here'}
      </Text>
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getStatusMeta(c: C): Record<BookingStatus, { label: string; icon: string; color: string; bg: string }> {
  return {
    pending:     { label: 'Pending',     icon: '🕐', color: c.warning,     bg: `${c.warning}18` },
    accepted:    { label: 'Accepted',    icon: '✅', color: c.success,     bg: `${c.success}18` },
    in_progress: { label: 'In Progress', icon: '⚡', color: c.info,        bg: `${c.info}18`    },
    completed:   { label: 'Completed',   icon: '🎉', color: c.success,     bg: `${c.success}18` },
    cancelled:   { label: 'Cancelled',   icon: '✕',  color: c.textMuted,   bg: c.surface        },
  };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

