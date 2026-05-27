// BookingsScreen — design-system port of `preview/bookings-screen.html`.
//
// Layout:
//   • Sticky header (back + title + sub + Upcoming/Past glass tabs with glider)
//   • Upcoming: "Live now" (active/in_progress) + "Scheduled" (pending) sections
//   • Past:     "This week" + "Earlier" sections
//   • Bottom tab bar (active=bookings)
//
// Card variants by status:
//   • active    → live-strip (helper avatar + ETA + call/chat) + Track on map CTA
//   • pending   → stops list (When/Where/Pro) + Add service / Cancel actions
//   • completed → rate stars OR Book again+Receipt
//   • cancelled → strikethrough price + "refunded to wallet" sub

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  
  Alert,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { getBookings, cancelBooking, type ApiBooking } from '../../api/bookings';

import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { ZopRefresh } from '../../components/home/ZopRefresh';
import { PressFx } from '../../components/ui/PressFx';
import { serviceIcon } from '../../components/home/serviceIcon';
import { showError } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import { EmptyState } from '../../components/EmptyState';
import { isBookingRated } from '../../utils/ratedBookingsStore';
import ZopSadSvg from '../../../assets/zop/zop-sad.svg';
import { BookingsScreenSkeleton } from '../../components/skeletons/BookingsScreenSkeleton';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontMono:  TextStyle = { fontFamily: 'PlusJakartaSans_500Medium', letterSpacing: 0.4 };

const H_PAD = 20;

// ── Helpers ─────────────────────────────────────────────────────────────────

function shortDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatScheduledHeader(iso?: string): string {
  if (!iso) return 'Scheduled';
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay(d, today))    return `Today · ${time}`;
  if (sameDay(d, tomorrow)) return `Tomorrow · ${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} · ${time}`;
}

function formatScheduledRange(iso: string, durationMin: number): string {
  const d = new Date(iso);
  const end = new Date(d.getTime() + durationMin * 60_000);
  const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const startT = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const endT   = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${dayLabel} · ${startT} – ${endT}`;
}

function isThisWeek(iso?: string): boolean {
  if (!iso) return false;
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return days >= 0 && days < 7;
}

function bookingId(b: ApiBooking): string {
  return `ZM-${b.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function formatINR(cents: number): string {
  return `₹${(cents / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

// ── Screen ──────────────────────────────────────────────────────────────────

type Tab = 'upcoming' | 'past';

// In-memory snapshot so re-entering Bookings shows the last-seen lists
// instantly while we silently refetch on focus.
const bookingsMemCache: { upcoming: ApiBooking[] | null; past: ApiBooking[] | null } = {
  upcoming: null,
  past:     null,
};

export default function BookingsScreen() {
  const { isDark } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  const [tab, setTab]           = useState<Tab>('upcoming');
  const [upcoming, setUpcoming] = useState<ApiBooking[]>(bookingsMemCache.upcoming ?? []);
  const [past,     setPast]     = useState<ApiBooking[]>(bookingsMemCache.past ?? []);
  const [loading,  setLoading]  = useState(bookingsMemCache.upcoming == null);
  const [pastPage, setPastPage] = useState(1);
  const [pastHasMore, setPastHasMore] = useState(true);
  const [pastVisibleLimit, setPastVisibleLimit] = useState(10);
  const [loadingMorePast, setLoadingMorePast] = useState(false);
  // Two-phase refresh: holdScreen drives RefreshControl, zopActive drives
  // ZopRefresh. Screen stays pulled down until the smile burst finishes.
  const [holdScreen, setHoldScreen] = useState(false);
  const [zopActive,  setZopActive]  = useState(false);

  const fetchAll = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const [up, pa] = await Promise.all([
        getBookings(token, 'upcoming'),
        getBookings(token, 'past', 1),
      ]);
      setUpcoming(up);
      setPast(pa);
      bookingsMemCache.upcoming = up;
      bookingsMemCache.past = pa;
      setPastPage(1);
      setPastVisibleLimit(10);
      setPastHasMore(pa.length >= 20);
    } catch {
      // keep previous data on failure
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      // Skeleton only on the very first load; later focuses revalidate silently.
      if (bookingsMemCache.upcoming == null) setLoading(true);
      fetchAll();
    }, [fetchAll]),
  );

  // Auto-show the rating screen for the most recent completed booking that
  // the customer hasn't rated yet. Guarded by ratedBookingsStore so the
  // prompt only fires once per booking, even across cold starts.
  useEffect(() => {
    if (loading || past.length === 0) return;
    let cancelled = false;
    (async () => {
      const candidate = past.find(
        (b) =>
          b.status === 'completed' &&
          (b.helper_rating == null || b.helper_rating === 0),
      );
      if (!candidate) return;
      const already = await isBookingRated(candidate.id);
      if (already || cancelled) return;
      navigation.navigate('BookingRate', {
        bookingId: candidate.id,
        helperId: candidate.helper_id ?? undefined,
        helperName: candidate.helper_name ?? undefined,
      });
    })();
    return () => { cancelled = true; };
  }, [loading, past, navigation]);

  const onRefresh = useCallback(async () => {
    setHoldScreen(true);
    setZopActive(true);
    try {
      await Promise.all([fetchAll(), new Promise((r) => setTimeout(r, 1100))]);
    } finally {
      setZopActive(false);
      setTimeout(() => setHoldScreen(false), 1300);
    }
  }, [fetchAll]);

  const handleLoadMorePast = useCallback(async () => {
    if (loadingMorePast) return;
    // Bump visible window first.
    const nextLimit = pastVisibleLimit + 10;
    setPastVisibleLimit(nextLimit);
    // Fetch the next page only when the new window will exceed what we have.
    if (token && pastHasMore && nextLimit > past.length) {
      setLoadingMorePast(true);
      try {
        const next = await getBookings(token, 'past', pastPage + 1);
        if (next.length > 0) {
          setPast((prev) => [...prev, ...next]);
          setPastPage(pastPage + 1);
        }
        if (next.length < 20) setPastHasMore(false);
      } catch {
        // Stop trying after a failure.
        setPastHasMore(false);
      } finally {
        setLoadingMorePast(false);
      }
    }
  }, [loadingMorePast, pastVisibleLimit, token, pastHasMore, past.length, pastPage]);

  const live      = useMemo(() => upcoming.filter((b) => b.status === 'accepted' || b.status === 'in_progress'), [upcoming]);
  const scheduled = useMemo(() => upcoming.filter((b) => b.status === 'pending'), [upcoming]);
  const visiblePast = useMemo(() => past.slice(0, pastVisibleLimit), [past, pastVisibleLimit]);
  const thisWeek  = useMemo(() => visiblePast.filter((b) => isThisWeek(b.scheduled_time || b.created_at)), [visiblePast]);
  const earlier   = useMemo(() => visiblePast.filter((b) => !isThisWeek(b.scheduled_time || b.created_at)), [visiblePast]);
  const canLoadMorePast = pastHasMore || pastVisibleLimit < past.length;

  const handleCancel = async (id: string) => {
    if (!token) return;
    try {
      await cancelBooking(token, id);
      setUpcoming((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not cancel.');
    }
  };

  const showEmpty =
    !loading &&
    ((tab === 'upcoming' && live.length === 0 && scheduled.length === 0) ||
     (tab === 'past' && past.length === 0));

  return (
    <View style={styles.safe}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <ScrollView
        style={{ flex: 1, backgroundColor: '#0A0A0A' }}
        contentContainerStyle={{ paddingBottom: 200, backgroundColor: '#0A0A0A' }}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[0]}
        refreshControl={
          <RefreshControl
            refreshing={holdScreen}
            onRefresh={onRefresh}
            tintColor="transparent"
            colors={['transparent']}
            progressBackgroundColor="transparent"
          />
        }
      >
        <View style={[styles.head, { paddingTop: insets.top + 10 }]}>
          <View style={styles.headRow}>
            <PressFx
              onPress={() => navigation.goBack()}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <Feather name="chevron-left" size={18} color="#FFFFFF" />
            </PressFx>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Your Bookings</Text>
            </View>
          </View>

          <Tabs
            tab={tab}
            onChange={setTab}
            upcomingCount={upcoming.length}
            pastCount={past.length}
          />
        </View>

        {loading ? (
          <BookingsScreenSkeleton />
        ) : tab === 'upcoming' ? (
          <>
            {live.length > 0 && (
              <>
                <Text style={styles.secH}>Live now</Text>
                <View style={styles.body}>
                  {live.map((b) => <ActiveCard key={b.id} booking={b} />)}
                </View>
              </>
            )}
            {scheduled.length > 0 && (
              <>
                <Text style={styles.secH}>Scheduled</Text>
                <View style={styles.body}>
                  {scheduled.map((b) => (
                    <ScheduledCard key={b.id} booking={b} onCancel={() => handleCancel(b.id)} />
                  ))}
                </View>
              </>
            )}
          </>
        ) : (
          <>
            {thisWeek.length > 0 && (
              <>
                <Text style={styles.secH}>This week</Text>
                <View style={styles.body}>
                  {thisWeek.map((b) => <PastCard key={b.id} booking={b} onRate={(book) => navigation.navigate('BookingRate', { bookingId: book.id, helperId: book.helper_id ?? undefined, helperName: book.helper_name ?? undefined })} onReport={(book) => navigation.navigate('ReportIssue', { bookingId: book.id, serviceName: book.services[0]?.service_name })} />)}
                </View>
              </>
            )}
            {earlier.length > 0 && (
              <>
                <Text style={styles.secH}>Earlier</Text>
                <View style={styles.body}>
                  {earlier.map((b) => <PastCard key={b.id} booking={b} onRate={(book) => navigation.navigate('BookingRate', { bookingId: book.id, helperId: book.helper_id ?? undefined, helperName: book.helper_name ?? undefined })} onReport={(book) => navigation.navigate('ReportIssue', { bookingId: book.id, serviceName: book.services[0]?.service_name })} />)}
                </View>
              </>
            )}
            {canLoadMorePast && past.length > 0 && (
              <View style={styles.body}>
                <PressFx
                  onPress={handleLoadMorePast}
                  disabled={loadingMorePast}
                  style={styles.loadMoreBtn}
                >
                  {loadingMorePast ? (
                    <LoadingBars size="small" color="#F5A300" />
                  ) : (
                    <>
                      <Feather name="chevron-down" size={14} color="#F5A300" />
                      <Text style={[fontBold, { color: '#F5A300', fontSize: 13 }]}>
                        Load more
                      </Text>
                    </>
                  )}
                </PressFx>
              </View>
            )}
          </>
        )}

        {showEmpty && (
          <Empty tab={tab} onCta={() => navigation.navigate('AllServices', {})} />
        )}
      </ScrollView>

      <ZopRefresh refreshing={zopActive} />
    </View>
  );
}

// ── Active card ─────────────────────────────────────────────────────────────

function ActiveCard({ booking }: { booking: ApiBooking }) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const svc = booking.services[0];
  const helperInitial = booking.helper_name?.[0]?.toUpperCase() ?? 'P';
  const startedAt = booking.scheduled_time
    ? new Date(booking.scheduled_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <GlassCard radius={20} style={styles.card}>
      <View style={styles.statusRow}>
        <StatusPill
          kind="active"
          label={booking.status === 'in_progress' ? 'In progress' : 'Pro on the way'}
        />
        <Text style={[fontMono, styles.bookingId]}>{bookingId(booking)}</Text>
      </View>

      <SvcRow
        service={svc}
        extraLine={`${booking.total_duration_minutes} min${startedAt ? ` · today, started ${startedAt}` : ''}`}
        priceCents={booking.price_paise}
      />

      <LiveStrip
        helperName={booking.helper_name ?? 'Pro'}
        helperInitial={helperInitial}
        rating={booking.helper_rating ?? 4.9}
        etaMin={6}
        distanceKm={1.2}
      />

      <View style={styles.actions}>
        <PressFx
          onPress={() =>
            navigation.navigate('TrackLive', {
              bookingId: booking.id,
              serviceName: svc?.service_name,
              helperName: booking.helper_name ?? 'Your Pro',
              helperRating: booking.helper_rating,
              etaMinutes: 6,
              distanceKm: 1.2,
            })
          }
          style={[styles.act, styles.actPrimary, { flex: 1 }]}
        >
          <Text style={[fontBold, { color: '#0D0D0F', fontSize: 13 }]}>Track on map</Text>
          <Feather name="chevron-right" size={14} color="#0D0D0F" />
        </PressFx>
        <PressFx
          onPress={() =>
            navigation.navigate('BookingConfirmed', {
              bookingId: booking.id,
              totalCents: booking.price_paise,
              bookingType: booking.scheduled_time ? 'scheduled' : 'instant',
              serviceId: svc?.service_id,
              serviceName: svc?.service_name,
              durationMinutes: booking.total_duration_minutes,
              helperName: booking.helper_name ?? 'Your Pro',
              helperRating: booking.helper_rating,
            })
          }
          style={[styles.act, styles.actSecondary, { flex: 1 }]}
        >
          <Text style={[fontBold, { color: 'rgba(255,255,255,0.9)', fontSize: 13 }]}>View booking</Text>
        </PressFx>
      </View>
    </GlassCard>
  );
}

// ── Scheduled card ──────────────────────────────────────────────────────────

function ScheduledCard({
  booking,
  onCancel,
}: {
  booking: ApiBooking;
  onCancel: () => Promise<void>;
}) {
  const svc = booking.services[0];
  const headerLabel = formatScheduledHeader(booking.scheduled_time);
  const stopWhen = booking.scheduled_time
    ? formatScheduledRange(booking.scheduled_time, booking.total_duration_minutes)
    : 'Scheduled';
  const totalServices = booking.services.length;
  const summaryName =
    totalServices > 1
      ? booking.services.map((s) => s.service_name).join(' + ')
      : svc?.service_name ?? 'Service';

  return (
    <GlassCard radius={20} style={styles.card}>
      <View style={styles.statusRow}>
        <StatusPill kind="scheduled" label={headerLabel} />
        <Text style={[fontMono, styles.bookingId]}>{bookingId(booking)}</Text>
      </View>

      <SvcRow
        service={svc}
        title={summaryName}
        extraLine={
          totalServices > 1
            ? `${totalServices} services · ${booking.total_duration_minutes} min total`
            : `${booking.total_duration_minutes} min`
        }
        priceCents={booking.price_paise}
      />

      <View style={styles.stops}>
        <Stop iconName="calendar" keyLabel="When" value={stopWhen} />
        <Stop
          iconName="map-pin"
          keyLabel="Where"
          value={booking.address_tag || booking.address_title || (booking.address_id ? 'Saved address' : 'Address pending')}
        />
        <Stop
          iconName="user"
          keyLabel="Pro"
          value={booking.helper_name ?? 'Auto-matching 30 min before'}
        />
      </View>

      <View style={styles.actions}>
        <PressFx style={[styles.act, styles.actSecondary, { flex: 1 }]}>
          <Feather name="plus" size={13} color="rgba(255,255,255,0.85)" />
          <Text style={[fontBold, { color: 'rgba(255,255,255,0.85)', fontSize: 13 }]}>Add service</Text>
        </PressFx>
        <PressFx
          onPress={() => {
            haptics.warning();
            Alert.alert('Cancel booking?', 'You may incur a small fee for late cancellations.', [
              { text: 'Keep', style: 'cancel' },
              { text: 'Cancel', style: 'destructive', onPress: onCancel },
            ]);
          }}
          style={[styles.act, styles.actDanger, { flex: 1 }]}
        >
          <Text style={[fontBold, { color: '#EF4444', fontSize: 13 }]}>Cancel</Text>
        </PressFx>
      </View>
    </GlassCard>
  );
}

// ── Past card ───────────────────────────────────────────────────────────────

function PastCard({ booking, onRate, onReport }: { booking: ApiBooking; onRate?: (b: ApiBooking) => void; onReport?: (b: ApiBooking) => void }) {
  const svc = booking.services[0];
  const stamp = booking.scheduled_time || booking.created_at;
  const date = shortDate(stamp);
  const time = stamp
    ? new Date(stamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';
  const isCancelled = booking.status === 'cancelled';
  const totalServices = booking.services.length;
  const summaryName =
    totalServices > 1
      ? booking.services.map((s) => s.service_name).slice(0, 2).join(' + ')
      : svc?.service_name ?? 'Service';
  const rated = booking.helper_rating != null && booking.helper_rating > 0;

  let extraLine: string;
  if (isCancelled) {
    extraLine = 'No charge · refunded to wallet';
  } else if (totalServices > 1) {
    extraLine = `${totalServices} services · ${booking.total_duration_minutes} min${booking.helper_name ? ` · with ${booking.helper_name}` : ''}`;
  } else {
    extraLine = `${booking.total_duration_minutes} min${booking.helper_name ? ` · with ${booking.helper_name}` : ''}${rated ? ` · ★ you rated ${booking.helper_rating?.toFixed(1)}` : ''}`;
  }

  return (
    <GlassCard radius={20} style={styles.card}>
      <View style={styles.statusRow}>
        <StatusPill
          kind={isCancelled ? 'cancelled' : 'completed'}
          label={`${isCancelled ? 'Cancelled' : 'Completed'} · ${date}`}
        />
        <Text style={[fontMono, styles.bookingId]}>{bookingId(booking)}</Text>
      </View>

      <SvcRow
        service={svc}
        title={summaryName}
        extraLine={extraLine}
        secondLine={time ? `Booked at ${time}` : undefined}
        priceCents={booking.price_paise}
        priceStruck={isCancelled}
      />

      {!isCancelled && !rated && (
        <PressFx onPress={() => onRate?.(booking)} style={styles.pastFoot}>
          <Text style={[fontMed, styles.pastLbl]}>Rate this service</Text>
          <View style={styles.starsRow}>
            {[1, 2, 3, 4].map((i) => (
              <Feather key={i} name="star" size={12} color="#F5A300" style={{ marginRight: 1 }} />
            ))}
            <Feather name="star" size={12} color="rgba(245,163,0,0.4)" />
            <Text style={[fontBold, { color: '#F5A300', fontSize: 11.5, marginLeft: 6 }]}>Tap to rate</Text>
          </View>
        </PressFx>
      )}

      {!isCancelled && rated && (
        <View style={styles.actions}>
          <PressFx style={[styles.act, styles.actPrimary, { flex: 1 }]}>
            <Feather name="rotate-cw" size={13} color="#0D0D0F" />
            <Text style={[fontBold, { color: '#0D0D0F', fontSize: 13 }]}>Book again</Text>
          </PressFx>
          <PressFx style={[styles.act, styles.actSecondary, { flex: 1 }]}>
            <Text style={[fontBold, { color: 'rgba(255,255,255,0.85)', fontSize: 13 }]}>Receipt</Text>
          </PressFx>
        </View>
      )}
      {!isCancelled && (
        <PressFx onPress={() => onReport?.(booking)} style={styles.reportBtn}>
          <Feather name="alert-circle" size={12} color="rgba(255,255,255,0.35)" />
          <Text style={[fontMed, styles.reportLabel]}>Report an issue</Text>
        </PressFx>
      )}
    </GlassCard>
  );
}

// ── Status pill ─────────────────────────────────────────────────────────────

type PillKind = 'active' | 'scheduled' | 'completed' | 'cancelled';

function StatusPill({ kind, label }: { kind: PillKind; label: string }) {
  const palette: Record<PillKind, { bg: string; fg: string; dot: string; pulse: boolean }> = {
    active:    { bg: 'rgba(34,197,94,0.14)',   fg: '#22C55E',                dot: '#22C55E',                pulse: true  },
    scheduled: { bg: 'rgba(245,163,0,0.14)',   fg: '#F5A300',                dot: '#F5A300',                pulse: false },
    completed: { bg: 'rgba(255,255,255,0.08)', fg: 'rgba(255,255,255,0.6)',  dot: 'rgba(255,255,255,0.4)',  pulse: false },
    cancelled: { bg: 'rgba(239,68,68,0.12)',   fg: '#EF4444',                dot: '#EF4444',                pulse: false },
  };
  const c = palette[kind];

  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      {c.pulse ? <PulseDot color={c.dot} /> : <View style={[styles.dot, { backgroundColor: c.dot }]} />}
      <Text
        style={[
          fontBold,
          { color: c.fg, fontSize: 10.5, letterSpacing: 0.2, textTransform: 'uppercase' },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function PulseDot({ color }: { color: string }) {
  const op = useSharedValue(1);
  useEffect(() => {
    op.value = withRepeat(
      withTiming(0.4, { duration: 750, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, []);
  const animStyle = useAnimatedStyle(() => ({ opacity: op.value }));
  return (
    <Animated.View
      style={[
        animStyle,
        styles.dot,
        {
          backgroundColor: color,
          shadowColor: color,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.8,
          shadowRadius: 4,
        },
      ]}
    />
  );
}

// ── Service row ─────────────────────────────────────────────────────────────

function SvcRow({
  service,
  title,
  extraLine,
  secondLine,
  priceCents,
  priceStruck,
}: {
  service?: ApiBooking['services'][number];
  title?: string;
  extraLine: string;
  secondLine?: string;
  priceCents: number;
  priceStruck?: boolean;
}) {
  const src = serviceIcon({ id: service?.service_id, name: service?.service_name });
  const displayTitle = title ?? service?.service_name ?? 'Service';

  return (
    <View style={styles.svcRow}>
      <View style={styles.svcIcon}>
        <View style={styles.svcIconBg} />
        <View
          pointerEvents="none"
          style={styles.svcIconAmber}
        />
        {src ? (
          <Image source={src} contentFit="contain" style={styles.svcIconImg} />
        ) : (
          <View
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Feather name="package" size={28} color="rgba(255,255,255,0.7)" />
          </View>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[fontBold, styles.svcTitle]} numberOfLines={2}>{displayTitle}</Text>
        <Text style={[fontMed, styles.svcExtra]} numberOfLines={2}>{extraLine}</Text>
        {secondLine && (
          <Text style={[fontMed, styles.svcSecond]} numberOfLines={1}>
            {secondLine}
          </Text>
        )}
      </View>
      <Text
        style={[
          fontExtra,
          styles.svcPrice,
          priceStruck && { textDecorationLine: 'line-through', opacity: 0.4 },
        ]}
      >
        {formatINR(priceCents)}
      </Text>
    </View>
  );
}

// ── Live strip ──────────────────────────────────────────────────────────────

function LiveStrip({
  helperName,
  helperInitial,
  rating,
  etaMin,
  distanceKm,
}: {
  helperName: string;
  helperInitial: string;
  rating: number;
  etaMin: number;
  distanceKm: number;
}) {
  return (
    <View style={styles.liveStrip}>
      <View style={styles.helperAvatar}>
        <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 14 }]}>{helperInitial}</Text>
        <View style={styles.helperOnline} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[fontBold, { color: '#FFFFFF', fontSize: 13, letterSpacing: -0.13 }]}>
          {helperName}
        </Text>
        <Text style={[fontMed, { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 }]}>
          ★ {rating.toFixed(1)} · arriving in{' '}
          <Text style={[fontBold, { color: '#22C55E' }]}>{etaMin} min</Text> · {distanceKm} km away
        </Text>
      </View>
      <View style={styles.liveActions}>
        <PressFx style={styles.liveBtn}>
          <Feather name="phone" size={14} color="#0D0D0F" />
        </PressFx>
        <PressFx style={styles.liveBtn}>
          <Feather name="message-square" size={14} color="#0D0D0F" />
        </PressFx>
      </View>
    </View>
  );
}

// ── Stop row ────────────────────────────────────────────────────────────────

function Stop({
  iconName,
  keyLabel,
  value,
}: {
  iconName: React.ComponentProps<typeof Feather>['name'];
  keyLabel: string;
  value: string;
}) {
  return (
    <View style={styles.stop}>
      <Text style={[fontSemi, styles.stopKey]}>{keyLabel}</Text>
      <Feather name={iconName} size={13} color="rgba(255,255,255,0.55)" style={{ marginRight: 6 }} />
      <Text
        style={[fontMed, { color: 'rgba(255,255,255,0.65)', fontSize: 11, flex: 1 }]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

// ── Tabs (Upcoming / Past) with glider ──────────────────────────────────────

function Tabs({
  tab,
  onChange,
  upcomingCount,
  pastCount,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  upcomingCount: number;
  pastCount: number;
}) {
  const [tabsW, setTabsW] = useState(0);
  const offset = useSharedValue(tab === 'upcoming' ? 0 : 1);

  useEffect(() => {
    // Snappy, near-critical damping — fast response, only a hint of overshoot.
    // Previous (damping 18, stiffness 220) read as too bouncy.
    offset.value = withSpring(tab === 'upcoming' ? 0 : 1, {
      damping: 26,
      stiffness: 320,
      mass: 0.7,
      overshootClamping: false,
    });
  }, [tab]);

  const gliderWidth = Math.max((tabsW - 8) / 2, 0);
  const gliderStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: 4 + offset.value * gliderWidth }],
  }));

  return (
    <View
      style={styles.tabsWrap}
      onLayout={(e) => setTabsW(e.nativeEvent.layout.width)}
    >
      <Animated.View
        style={[
          styles.glider,
          { width: gliderWidth },
          gliderStyle,
        ]}
      />
      <PressFx onPress={() => onChange('upcoming')} style={styles.tabItem}>
        <Text style={[fontBold, styles.tabLabel, tab === 'upcoming' && styles.tabLabelActive]}>
          Upcoming
        </Text>
        <View style={[styles.tabBadge, tab === 'upcoming' && styles.tabBadgeActive]}>
          <Text style={[fontBold, styles.tabBadgeText, tab === 'upcoming' && styles.tabBadgeTextActive]}>
            {upcomingCount}
          </Text>
        </View>
      </PressFx>
      <PressFx onPress={() => onChange('past')} style={styles.tabItem}>
        <Text style={[fontBold, styles.tabLabel, tab === 'past' && styles.tabLabelActive]}>
          Past
        </Text>
        <View style={[styles.tabBadge, tab === 'past' && styles.tabBadgeActive]}>
          <Text style={[fontBold, styles.tabBadgeText, tab === 'past' && styles.tabBadgeTextActive]}>
            {pastCount}
          </Text>
        </View>
      </PressFx>
    </View>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function Empty({ tab, onCta }: { tab: Tab; onCta: () => void }) {
  return (
    <EmptyState
      illustration={<ZopSadSvg width={180} height={180} />}
      title={tab === 'upcoming' ? 'No bookings yet' : 'Nothing here yet'}
      subtitle={
        tab === 'upcoming'
          ? "Let's fix that. Pick a service and your helper will be on the way."
          : 'Your completed bookings will show up here.'
      }
      ctaLabel={tab === 'upcoming' ? 'Browse services' : undefined}
      onCtaPress={tab === 'upcoming' ? onCta : undefined}
    />
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },

  head: {
    backgroundColor: 'rgba(10,10,10,0.92)',
    paddingTop: 10,
    paddingBottom: 14,
    paddingHorizontal: H_PAD,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.05)',
    zIndex: 30,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  title: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 24, color: '#FFFFFF',
    letterSpacing: -0.6, lineHeight: 26,
  },
  subtitle: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 11, color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },

  tabsWrap: {
    height: 42,
    borderRadius: 14,
    padding: 4,
    flexDirection: 'row',
    position: 'relative',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  glider: {
    position: 'absolute',
    top: 4,
    left: 0,
    height: 34,
    borderRadius: 11,
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    zIndex: 1,
  },
  tabLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: 'rgba(255,255,255,0.55)',
    letterSpacing: -0.13,
  },
  tabLabelActive: { color: '#0D0D0F', fontFamily: 'PlusJakartaSans_700Bold' },
  tabBadge: {
    paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  tabBadgeActive: { backgroundColor: 'rgba(13,13,15,0.14)' },
  tabBadgeText: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 10,
    color: 'rgba(255,255,255,0.65)',
  },
  tabBadgeTextActive: { color: '#0D0D0F' },

  loadWrap: { padding: 60, alignItems: 'center' },

  secH: {
    paddingHorizontal: H_PAD,
    paddingTop: 14,
    paddingBottom: 8,
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 11,
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 0.88,
    textTransform: 'uppercase',
  },

  body: { paddingHorizontal: H_PAD },

  card: { padding: 14, marginBottom: 12, overflow: 'hidden' },

  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  bookingId: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 0.4,
  },

  // Service row + mini icon stage
  svcRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  svcIcon: {
    width: 56, height: 56, borderRadius: 14,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#0F0F11',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  svcIconBg: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#1A1A1C',
  },
  svcIconAmber: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: -8,
    height: 22,
    borderRadius: 14,
    backgroundColor: 'rgba(245,163,0,0.18)',
    opacity: 0.9,
  },
  svcIconImg: {
    position: 'absolute',
    left: '11%', top: '11%',
    width: '78%', height: '78%',
  },
  svcTitle: {
    fontSize: 15,
    color: '#FFFFFF',
    letterSpacing: -0.2,
    lineHeight: 18,
  },
  svcExtra: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 3,
    lineHeight: 14,
  },
  svcSecond: {
    fontSize: 10.5,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 2,
    letterSpacing: 0.1,
  },
  svcPrice: { fontSize: 15, color: '#FFFFFF', letterSpacing: -0.3 },

  // Live strip
  liveStrip: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(34,197,94,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.3)',
  },
  helperAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#F5A300',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#F5A300',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
    position: 'relative',
  },
  helperOnline: {
    position: 'absolute',
    bottom: -1, right: -1,
    width: 11, height: 11, borderRadius: 6,
    backgroundColor: '#22C55E',
    borderWidth: 2,
    borderColor: '#0A0A0A',
  },
  liveActions: { flexDirection: 'row', gap: 6 },
  liveBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.96)',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },

  // Stops list
  stops: {
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  stop: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
  },
  stopKey: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.45)',
    minWidth: 48,
    marginRight: 8,
  },

  // Actions
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  act: {
    height: 38,
    borderRadius: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  actPrimary: {
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  actSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  actDanger: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
  },

  // Past foot (rate stars)
  pastFoot: {
    marginTop: 10,
    paddingTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  pastLbl: { fontSize: 11, color: 'rgba(255,255,255,0.5)' },
  starsRow: { flexDirection: 'row', alignItems: 'center' },
  reportBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, justifyContent: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.05)' },
  reportLabel: { fontSize: 11, color: 'rgba(255,255,255,0.3)' },

  // Empty
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
    paddingHorizontal: 30,
  },
  emptyIcon: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,163,0,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.32)',
    marginBottom: 18,
  },
  emptyH3: {
    fontSize: 18,
    color: '#FFFFFF',
    letterSpacing: -0.36,
    marginBottom: 6,
  },
  emptyP: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.55)',
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 18,
    maxWidth: 240,
  },
  loadMoreBtn: {
    height: 44,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(245,163,0,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.32)',
    marginTop: 6,
    marginBottom: 4,
  },
  emptyCta: {
    height: 42, paddingHorizontal: 20, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
});
