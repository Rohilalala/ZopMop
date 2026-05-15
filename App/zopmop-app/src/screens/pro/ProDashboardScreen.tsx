import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Alert,
  RefreshControl,
  AppState,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SkeletonBox } from '../../components/SkeletonBox';
import { Feather } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import * as Location from 'expo-location';
import { isConnected as getIsConnected, addConnectivityListener } from '../../utils/netInfo';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { getHelperInvitesWithDetails } from '../../api/matching';
import { getHelperActive, getHelperToday, getHelperStats, type HelperBooking, type HelperStats } from '../../api/pro';
import { getBalance, getAffectedTomorrow, type LeaveBalance, type AffectedBooking } from '../../api/leave';
import { apiFetch } from '../../api/client';
import { BASE_URL } from '../../api/config';
import { haptics } from '../../utils/haptics';
import OfflineBanner from '../../components/OfflineBanner';
import SvgIcon from '../../components/SvgIcon';
import type { SvgIconName } from '../../components/SvgIcon';
import { showError } from '../../utils/toast';
import { enqueueLocationPing, flushLocationPingQueue } from '../../utils/locationPingQueue';

// Location heartbeat cadence. Faster while a booking is active so the customer
// map stays smooth; slower while idle to spare battery + backend load.
const BOOKING_ACTIVE_HEARTBEAT_MS = 30 * 1000;
const IDLE_HEARTBEAT_MS = 2 * 60 * 1000;

export default function ProDashboardScreen() {
  useProRoleGate();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token, user, signOut } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  // Today's bookings panel state — current (accepted/in_progress) + past today.
  const [todayBookings, setTodayBookings] = useState<HelperBooking[]>([]);
  const [todayLoading, setTodayLoading] = useState(true);

  const [stats, setStats] = useState<HelperStats | null>(null);

  // Tomorrow + leave-balance state for the leave-declaration UI. Refetched on
  // focus so the pro sees fresh values after coming back from declare/profile.
  const [tomorrowBookings, setTomorrowBookings] = useState<AffectedBooking[]>([]);
  const [leaveBalance, setLeaveBalance] = useState<LeaveBalance | null>(null);
  const [tomorrowLoading, setTomorrowLoading] = useState(true);

  const refreshLeaveContext = useCallback(async () => {
    if (!token || token === '__guest__') return;
    try {
      const [bal, aff] = await Promise.all([
        getBalance(token).catch(() => null),
        getAffectedTomorrow(token).catch(() => [] as AffectedBooking[]),
      ]);
      setLeaveBalance(bal);
      setTomorrowBookings(aff);
    } finally {
      setTomorrowLoading(false);
    }
  }, [token]);

  const refreshToday = useCallback(async () => {
    if (!token || token === '__guest__') return;
    try {
      const list = await getHelperToday(token);
      setTodayBookings(list);
    } catch (e) {
      if (__DEV__) console.warn('refreshToday:', e);
    } finally {
      setTodayLoading(false);
    }
  }, [token]);

  // Fetch lifetime stats once on mount. Non-critical — failure just leaves em-dashes.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    getHelperStats(token).then(setStats).catch(() => {});
  }, [token]);

  // On mount: recover an active booking via the helper-side endpoint (the
  // legacy /bookings?status=upcoming returned customer bookings, so the pro
  // saw nothing). Still bail to ProActive on any active match for continuity.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    let cancelled = false;
    (async () => {
      try {
        const active = await getHelperActive(token);
        if (cancelled) return;
        if (active.length > 0) {
          const a = active[0];
          // P14: 'Customer Location' is shown only when the helper-active
          // payload omits address — backend should always provide one.
          navigation.replace('ProActive', {
            bookingId: a.id,
            serviceName: undefined,
            customerAddress: a.address ?? 'Customer Location',
            customerLat: a.lat ?? 0,
            customerLng: a.lng ?? 0,
          });
          return;
        }
        await refreshToday();
      } catch {
        // network blip — render an empty dashboard rather than crash
        if (!cancelled) setTodayLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, refreshToday]);

  // Keep today's panel fresh — refresh on focus + every 30 s while mounted.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    const id = setInterval(refreshToday, 30_000);
    const sub = navigation.addListener('focus', refreshToday);
    return () => {
      clearInterval(id);
      sub();
    };
  }, [token, navigation, refreshToday]);

  // Tomorrow + balance refresh on focus. No interval — far less time-sensitive
  // than today's panel, and we want a fresh read after the pro returns from
  // the declare flow (balance changes, affected list goes empty).
  useEffect(() => {
    if (!token || token === '__guest__') return;
    refreshLeaveContext();
    const sub = navigation.addListener('focus', refreshLeaveContext);
    return () => { sub(); };
  }, [token, navigation, refreshLeaveContext]);

  const [isOnline, setIsOnline] = useState(false);
  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);

  // Sync isOnline with backend state on mount so the toggle reflects reality
  // after the app is killed and relaunched while the pro was online.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    apiFetch(`${BASE_URL}/helpers/me/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.is_available) setIsOnline(true); })
      .catch(() => {});
  }, [token]);
  const [toggling, setToggling] = useState(false);
  const [checkingInvites, setCheckingInvites] = useState(false);
  const [inviteCount, setInviteCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigatingToBookingRef = useRef(false);
  const isOnlineRef = useRef(false);

  // True when the pro has an accepted/in_progress booking — drives the faster
  // 30s heartbeat cadence below. Tracked via ref so the AppState listener and
  // the toggle handler can read the latest value without re-binding.
  const hasActiveBooking = useMemo(
    () => todayBookings.some(
      (b) => b.status === 'accepted' || b.status === 'in_progress',
    ),
    [todayBookings],
  );
  const hasActiveBookingRef = useRef(hasActiveBooking);
  useEffect(() => {
    hasActiveBookingRef.current = hasActiveBooking;
  }, [hasActiveBooking]);

  function heartbeatIntervalMs(): number {
    return hasActiveBookingRef.current
      ? BOOKING_ACTIVE_HEARTBEAT_MS
      : IDLE_HEARTBEAT_MS;
  }

  // Pulse ring for GO ONLINE button
  const ringScale = useRef(new Animated.Value(1)).current;
  const ringOpacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    if (isOnline) {
      Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(ringScale, { toValue: 1.35, duration: 1000, useNativeDriver: true }),
            Animated.timing(ringScale, { toValue: 1, duration: 1000, useNativeDriver: true }),
          ]),
          Animated.sequence([
            Animated.timing(ringOpacity, { toValue: 0, duration: 1000, useNativeDriver: true }),
            Animated.timing(ringOpacity, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
          ]),
        ])
      ).start();
    } else {
      ringScale.stopAnimation(); ringScale.setValue(1);
      ringOpacity.stopAnimation(); ringOpacity.setValue(0.4);
    }
  }, [isOnline]);

  const checkInvites = useCallback(async () => {
    if (!token || token === '__guest__') return;
    if (navigatingToBookingRef.current) return;
    setCheckingInvites(true);
    try {
      const invites = await getHelperInvitesWithDetails(token);
      setInviteCount(invites.length);
      if (invites.length > 0 && !navigatingToBookingRef.current) {
        navigatingToBookingRef.current = true;
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        const invite = invites[0];
        // P13: 'Service' fallback shown only when invite.services is empty —
        // backend should always supply a non-empty services array. P14: same
        // for address. Both flagged for matching API contract review.
        navigation.navigate('ProMatched', {
          bookingId: invite.booking_id.trim(),
          serviceName: invite.services?.[0] ?? 'Service',
          customerAddress: invite.address || 'Customer Location',
          customerLat: invite.lat,
          customerLng: invite.lng,
        });
      }
    } catch {
      // retry on next cycle
    } finally {
      setCheckingInvites(false);
    }
  }, [token]);

  const INVITE_POLL_MS = 8_000;

  useEffect(() => {
    navigatingToBookingRef.current = false;
    if (isOnline) {
      checkInvites();
      pollRef.current = setInterval(checkInvites, INVITE_POLL_MS);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
      setInviteCount(0);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (locationHeartbeatRef.current) clearInterval(locationHeartbeatRef.current);
    };
  }, [isOnline, checkInvites]);

  // Pause invite poll when screen loses focus; resume on focus.
  useEffect(() => {
    const onBlur = () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
    const onFocus = () => {
      if (isOnlineRef.current && !pollRef.current) {
        navigatingToBookingRef.current = false;
        checkInvites();
        pollRef.current = setInterval(checkInvites, INVITE_POLL_MS);
      }
    };
    const unsubBlur = navigation.addListener('blur', onBlur);
    const unsubFocus = navigation.addListener('focus', onFocus);
    return () => { unsubBlur(); unsubFocus(); };
  }, [navigation, checkInvites]);

  async function pushLocation(): Promise<boolean> {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return false;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const timestamp = Date.now();

      const online = await getIsConnected();
      if (!online) {
        await enqueueLocationPing({ lat, lng, timestamp });
        return true;
      }

      await apiFetch(`${BASE_URL}/helpers/me/location`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ lat, lng, timestamp }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function handleToggle() {
    if (toggling) return;
    haptics.medium();
    setToggling(true);
    try {
      if (!isOnline) {
        const ok = await pushLocation();
        if (!ok) {
          showError('Enable location permission to go online.', { title: 'Location needed' });
          return;
        }
        haptics.success();
        // Guard: clear any pre-existing interval before assigning a new one
        // (prevents stacking if state ever desyncs with the ref).
        if (locationHeartbeatRef.current) {
          clearInterval(locationHeartbeatRef.current);
          locationHeartbeatRef.current = null;
        }
        locationHeartbeatRef.current = setInterval(pushLocation, heartbeatIntervalMs());
        setIsOnline(true);
      } else {
        if (locationHeartbeatRef.current) {
          clearInterval(locationHeartbeatRef.current);
          locationHeartbeatRef.current = null;
        }
        apiFetch(`${BASE_URL}/helpers/me/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ is_available: false }),
        }).catch(() => {});
        haptics.light();
        setIsOnline(false);
      }
    } finally {
      setToggling(false);
    }
  }

  // Drain queued offline pings whenever connectivity returns.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    let wasOffline = false;
    const unsub = addConnectivityListener((online) => {
      if (online && wasOffline) {
        flushLocationPingQueue(token).catch(() => {});
      }
      wasOffline = !online;
    });
    return () => unsub();
  }, [token]);

  // Pause the location heartbeat when the app is backgrounded; resume on foreground.
  // This avoids burning battery + uploading stale GPS while the user is away.
  useEffect(() => {
    if (!isOnline) return;
    const sub = AppState.addEventListener('change', (next) => {
      if ((next === 'background' || next === 'inactive') && locationHeartbeatRef.current) {
        clearInterval(locationHeartbeatRef.current);
        locationHeartbeatRef.current = null;
      } else if (next === 'active' && !locationHeartbeatRef.current && isOnline) {
        // Push immediately so backend sees us as fresh, then resume cadence.
        pushLocation();
        locationHeartbeatRef.current = setInterval(pushLocation, heartbeatIntervalMs());
      }
    });
    return () => sub.remove();
  }, [isOnline]);

  // Swap heartbeat cadence when a booking becomes active / clears, but only
  // while the heartbeat is actually running (online + foregrounded).
  useEffect(() => {
    if (!isOnline) return;
    if (!locationHeartbeatRef.current) return;
    clearInterval(locationHeartbeatRef.current);
    // Push immediately so the customer sees the updated position right away.
    pushLocation();
    locationHeartbeatRef.current = setInterval(pushLocation, heartbeatIntervalMs());
  }, [hasActiveBooking, isOnline]);

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.all([
      refreshToday(),
      refreshLeaveContext(),
      getHelperStats(token!).then(setStats).catch(() => {}),
    ]);
    setRefreshing(false);
  }

  function handleSignOut() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  }

  const firstName = user?.name?.split(' ')[0] ?? 'Pro';

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <OfflineBanner />
      <ScrollView
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.greeting}>Hey, {firstName}</Text>
            <Text style={s.subGreeting}>Ready to earn today?</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {checkingInvites && <LoadingBars size="small" color={c.primary} />}
            <TouchableOpacity
              onPress={() => navigation.navigate('ProProfile')}
              activeOpacity={0.7}
              accessibilityLabel="Profile"
              accessibilityRole="button"
              style={{
                width: 44, height: 44, borderRadius: 22,
                alignItems: 'center', justifyContent: 'center',
                borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
              }}
            >
              <Feather name="user" size={16} color={c.text} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Stats row — pros are salaried staff, not gig workers. Earnings tile
            removed per project_design_conventions; do not reintroduce. */}
        <View style={s.statsRow}>
          <StatCard iconName="star-filled" label="Rating" value={stats ? stats.average_rating.toFixed(1) : '—'} />
          <StatCard iconName="check-circle" label="Jobs Done" value={stats ? String(stats.total_jobs) : '—'} />
        </View>

        {/* GO ONLINE button */}
        <View style={s.goOnlineSection}>
          <TouchableOpacity
            onPress={handleToggle}
            activeOpacity={0.88}
            disabled={toggling}
            style={s.goOnlineTouchable}
            accessibilityLabel={isOnline ? 'Go offline' : 'Go online'}
            accessibilityRole="button"
          >
            <View style={s.goOnlineOuter}>
              {isOnline && (
                <Animated.View style={[
                  s.goOnlineRing,
                  { transform: [{ scale: ringScale }], opacity: ringOpacity },
                ]} />
              )}
              <View style={[s.goOnlineBtn, isOnline && s.goOnlineBtnActive]}>
                {toggling
                  ? <LoadingBars color={isOnline ? '#FFFFFF' : c.primary} size="large" />
                  : <SvgIcon name={isOnline ? 'dot-online' : 'dot-offline'} size={28} color={isOnline ? '#3DDC84' : c.textMuted} />
                }
                <Text style={[s.goOnlineLabel, isOnline && { color: '#FFFFFF' }]}>
                  {isOnline ? 'YOU\'RE LIVE' : 'GO ONLINE'}
                </Text>
                <Text style={[s.goOnlineSub, isOnline && { color: 'rgba(255,255,255,0.75)' }]}>
                  {isOnline ? 'Tap to go offline' : 'Tap to start earning'}
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          {isOnline && (
            <View style={s.scanningRow}>
              <View style={s.scanningDot} />
              <Text style={s.scanningText}>
                {inviteCount > 0
                  ? `${inviteCount} booking invite${inviteCount > 1 ? 's' : ''} waiting!`
                  : 'Scanning for nearby bookings…'
                }
              </Text>
            </View>
          )}
        </View>

        {/* Today's bookings — current + past today, recoverable across restarts */}
        <TodayPanel
          loading={todayLoading}
          bookings={todayBookings}
          onTapActive={(b) =>
            navigation.navigate('ProActive', {
              bookingId: b.id,
              serviceName: undefined,
              customerAddress: b.address,
              customerLat: b.lat,
              customerLng: b.lng,
            })
          }
        />

        {/* Tomorrow's scheduled bookings + Declare Leave entry. Read-only. */}
        <TomorrowPanel
          loading={tomorrowLoading}
          bookings={tomorrowBookings}
          balance={leaveBalance}
          onDeclareLeave={() => navigation.navigate('ProDeclareLeave')}
        />

        {/* How it works */}
        <View style={s.howCard}>
          <Text style={s.howTitle}>How ZopMop works</Text>
          <View style={s.howSteps}>
            <HowStep n="1" text="Go online — we find customers near you" />
            <HowStep n="2" text="Accept a booking invite when it appears" />
            <HowStep n="3" text="Complete the job and get rated" />
          </View>
        </View>

        {/* Sign out */}
        <TouchableOpacity style={s.signOutBtn} onPress={handleSignOut} activeOpacity={0.7}>
          <Text style={s.signOutText}>Sign Out</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({ iconName, label, value }: { iconName: SvgIconName; label: string; value: string }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.statCard}>
      <SvgIcon name={iconName} size={22} color={c.primary} />
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function TodayPanel({
  loading,
  bookings,
  onTapActive,
}: {
  loading: boolean;
  bookings: HelperBooking[];
  onTapActive: (b: HelperBooking) => void;
}) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const active = bookings.filter(
    b => b.status === 'accepted' || b.status === 'in_progress',
  );
  const past = bookings.filter(
    b => b.status === 'completed' || b.status === 'cancelled',
  );

  // price_paise / discount_paise store paise (not cents) — named per existing API contract.
  const earnedPaise = past
    .filter(b => b.status === 'completed')
    .reduce((sum, b) => sum + (b.price_paise - b.discount_paise), 0);
  const earnedRupees = `₹${Math.round(earnedPaise / 100)}`;

  return (
    <View style={s.todayCard}>
      <View style={s.todayHeader}>
        <Text style={s.todayTitle}>Today</Text>
        <Text style={s.todayMeta}>
          {past.filter(b => b.status === 'completed').length} done · {earnedRupees} earned
        </Text>
      </View>

      {loading && (
        <View style={{ paddingVertical: 8, gap: 14 }}>
          {[0, 1].map((i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <SkeletonBox width={10 as any} height={10} borderRadius={5} />
              <View style={{ flex: 1, gap: 6 }}>
                <SkeletonBox width="60%" height={12} borderRadius={5} />
                <SkeletonBox width="38%" height={10} borderRadius={5} />
              </View>
            </View>
          ))}
        </View>
      )}

      {!loading && bookings.length === 0 && (
        <Text style={s.todayEmpty}>
          No jobs yet today. Go online to start receiving invites.
        </Text>
      )}

      {active.map(b => (
        <TouchableOpacity
          key={b.id}
          style={s.todayRowActive}
          onPress={() => onTapActive(b)}
          activeOpacity={0.85}
        >
          <View style={s.todayDotActive} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.todayRowTitle} numberOfLines={1}>
              {b.status === 'in_progress' ? 'In progress' : 'On the way'}
            </Text>
            <Text style={s.todayRowSub} numberOfLines={1}>
              {b.address || 'Customer location'}
            </Text>
          </View>
          <Text style={s.todayRowCta}>Open ›</Text>
        </TouchableOpacity>
      ))}

      {past.map(b => (
        <View key={b.id} style={s.todayRow}>
          <View
            style={[
              s.todayDot,
              b.status === 'completed' ? s.todayDotDone : s.todayDotCancelled,
            ]}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.todayRowTitle} numberOfLines={1}>
              {b.status === 'completed' ? 'Completed' : 'Cancelled'}
            </Text>
            <Text style={s.todayRowSub} numberOfLines={1}>
              {b.address || 'Customer location'}
            </Text>
          </View>
          <Text style={s.todayRowAmount}>
            ₹{Math.round((b.price_paise - b.discount_paise) / 100)}
          </Text>
        </View>
      ))}
    </View>
  );
}

// isBefore9pmIST returns true when current local time, projected to IST, is
// strictly before 21:00. Drives the show/hide on the Declare Leave button —
// per spec, after 9pm the button vanishes entirely (no disabled state).
function isBefore9pmIST(now: Date = new Date()): boolean {
  const hourStr = now.toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  });
  const hour = parseInt(hourStr, 10);
  return Number.isFinite(hour) && hour < 21;
}

function fmtSlotIST(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function TomorrowPanel({
  loading,
  bookings,
  balance,
  onDeclareLeave,
}: {
  loading: boolean;
  bookings: AffectedBooking[];
  balance: LeaveBalance | null;
  onDeclareLeave: () => void;
}) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const showDeclare = isBefore9pmIST();

  return (
    <View style={s.todayCard}>
      <View style={s.todayHeader}>
        <Text style={s.todayTitle}>Tomorrow</Text>
        <Text style={s.todayMeta}>
          {bookings.length} scheduled
        </Text>
      </View>

      {loading && (
        <View style={{ paddingVertical: 8, gap: 14 }}>
          {[0, 1].map((i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <SkeletonBox width={10 as any} height={10} borderRadius={5} />
              <View style={{ flex: 1, gap: 6 }}>
                <SkeletonBox width="60%" height={12} borderRadius={5} />
                <SkeletonBox width="38%" height={10} borderRadius={5} />
              </View>
            </View>
          ))}
        </View>
      )}

      {!loading && bookings.length === 0 && (
        <Text style={s.todayEmpty}>No scheduled bookings for tomorrow.</Text>
      )}

      {bookings.map((b) => (
        <View key={b.ID} style={s.todayRow}>
          <View style={[s.todayDot, s.todayDotDone]} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.todayRowTitle} numberOfLines={1}>
              {b.ServiceName || 'Scheduled service'} · {fmtSlotIST(b.ScheduledTime)}
            </Text>
            <Text style={s.todayRowSub} numberOfLines={1}>
              {b.CustomerName || 'Customer'}
            </Text>
          </View>
        </View>
      ))}

      {/* Balance line + Declare Leave button. Hidden entirely after 21:00 IST. */}
      {showDeclare && (
        <View style={{ marginTop: 12, gap: 10 }}>
          {balance && (
            <Text style={[s.todayRowSub, { textAlign: 'center' }]}>
              {balance.balance > 0
                ? `You have ${balance.balance} leave day${balance.balance === 1 ? '' : 's'} remaining this month`
                : 'No leave days remaining. Contact your manager.'}
            </Text>
          )}
          <TouchableOpacity
            onPress={onDeclareLeave}
            disabled={!balance || balance.balance <= 0}
            activeOpacity={0.85}
            style={{
              alignSelf: 'stretch',
              paddingVertical: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: 'rgba(245,163,0,0.45)',
              backgroundColor: !balance || balance.balance <= 0 ? 'rgba(255,255,255,0.04)' : 'rgba(245,163,0,0.10)',
              alignItems: 'center',
              opacity: !balance || balance.balance <= 0 ? 0.55 : 1,
            }}
          >
            <Text style={{ color: c.primary, fontFamily: FontFamily.bold, fontSize: 13, letterSpacing: 0.2 }}>
              Declare Leave for Tomorrow
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function HowStep({ n, text }: { n: string; text: string }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.howStep}>
      <View style={s.howStepNum}><Text style={s.howStepNumText}>{n}</Text></View>
      <Text style={s.howStepText}>{text}</Text>
    </View>
  );
}

const BUTTON_SIZE = 164;

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    content: { padding: 20, gap: 20, paddingBottom: 40 },

    header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
    greeting: { fontFamily: FontFamily.extrabold, fontSize: FontSize['2xl'], color: c.text, letterSpacing: -0.5 },
    subGreeting: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted, marginTop: 2 },

    statsRow: { flexDirection: 'row', gap: 10 },
    statCard: {
      flex: 1, backgroundColor: c.white,
      borderRadius: Radius.xl, padding: 14,
      alignItems: 'center', gap: 4,
      borderWidth: 1, borderColor: c.border,
      ...Shadow.sm,
    },
    statValue: { fontFamily: FontFamily.extrabold, fontSize: FontSize.lg, color: c.text },
    statLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },

    goOnlineSection: { alignItems: 'center', gap: 16, paddingVertical: 8 },
    goOnlineTouchable: { alignItems: 'center' },
    goOnlineOuter: { width: BUTTON_SIZE + 40, height: BUTTON_SIZE + 40, alignItems: 'center', justifyContent: 'center' },
    goOnlineRing: {
      position: 'absolute',
      width: BUTTON_SIZE + 32,
      height: BUTTON_SIZE + 32,
      borderRadius: (BUTTON_SIZE + 32) / 2,
      backgroundColor: c.primary,
    },
    goOnlineBtn: {
      width: BUTTON_SIZE, height: BUTTON_SIZE,
      borderRadius: BUTTON_SIZE / 2,
      backgroundColor: c.surface,
      borderWidth: 3, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
      gap: 4,
      ...Shadow.lg,
    },
    goOnlineBtnActive: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    goOnlineLabel: { fontFamily: FontFamily.extrabold, fontSize: FontSize.base, color: c.text, letterSpacing: 0.5 },
    goOnlineSub: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },

    scanningRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    scanningDot: { width: 8, height: 8, borderRadius: Radius.full, backgroundColor: c.success },
    scanningText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.success },

    todayCard: {
      backgroundColor: c.white, borderRadius: Radius.xl,
      padding: 16, borderWidth: 1, borderColor: c.border, gap: 8, ...Shadow.sm,
    },
    todayHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 },
    todayTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text },
    todayMeta: { fontFamily: FontFamily.medium, fontSize: FontSize.xs, color: c.textMuted },
    todayEmpty: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted, paddingVertical: 8 },
    todayRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
    todayRowActive: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingVertical: 12, paddingHorizontal: 12,
      borderRadius: Radius.md,
      backgroundColor: c.primaryBg,
      borderWidth: 1, borderColor: c.primary,
    },
    todayDot: { width: 8, height: 8, borderRadius: 4 },
    todayDotActive: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.primary },
    todayDotDone: { backgroundColor: c.success },
    todayDotCancelled: { backgroundColor: c.textMuted },
    todayRowTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.text },
    todayRowSub: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, marginTop: 1 },
    todayRowCta: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.primary },
    todayRowAmount: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.text },

    howCard: {
      backgroundColor: c.white, borderRadius: Radius.xl,
      padding: 20, borderWidth: 1, borderColor: c.border, gap: 14, ...Shadow.sm,
    },
    howTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text },
    howSteps: { gap: 12 },
    howStep: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    howStepNum: {
      width: 28, height: 28, borderRadius: Radius.full,
      backgroundColor: c.primaryBg,
      alignItems: 'center', justifyContent: 'center',
    },
    howStepNumText: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.primary },
    howStepText: { flex: 1, fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, lineHeight: 20 },

    signOutBtn: {
      alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10,
      borderRadius: Radius.full,
      borderWidth: 1, borderColor: c.border,
      backgroundColor: c.white,
    },
    signOutText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.textMuted },
  });
}
