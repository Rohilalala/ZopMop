// TrackLiveScreen — customer-side state machine for the full booking lifecycle.
// Sub-states are derived from booking lifecycle timestamps fetched via
// GET /bookings/:id (BookingDetail) and refreshed on every booking_status_change
// FCM event:
//
//   dispatching → assigned → en_route → arrived → in_progress → completed
//   (cancelled is a terminal alt-state reachable from any pre-completed state)
//
// All copy is English — customer app is English-only. The pro-side i18n
// (zopmop-app/src/i18n/hi.ts + en.ts) is scoped to src/screens/pro/* and
// is not used here.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { PressFx } from '../../components/ui/PressFx';
import ServiceComplete from '../../components/ServiceComplete';
import { SuccessBackdrop } from '../../components/SuccessBackdrop';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useC, type ScreenColors } from '../../theme/screen';
import {
  getBookingTrackingWsUrl,
  getBookingDetail,
  submitBookingReview,
  type BookingDetail,
  type TrackingResponse,
} from '../../api/matching';
import { createCashfreeOrder, CashfreeOrderError } from '../../api/payments';
import { useCashfreePayment } from '../../hooks/useCashfreePayment';
import { onShiftEvent } from '../../utils/shiftEvents';
import { showError } from '../../utils/toast';
import polyline from '@mapbox/polyline';

// ── Sub-state derivation ─────────────────────────────────────────────────────

type SubState =
  | 'dispatching'
  | 'assigned'
  | 'en_route'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_pro_available'
  | 'no_show';

function deriveSubState(d: BookingDetail | null): SubState {
  if (!d) return 'dispatching';
  if (d.status === 'cancelled') {
    // The unified flow's unfilled-booking terminal state is status='cancelled'
    // with cancelled_by='no_pros_found' (assigner + ASAP no-pro path). Surface
    // the tailored no-pros rebook panel for it; everything else cancelled
    // (customer/system) gets the generic cancelled UI.
    return d.cancelled_by === 'no_pros_found' ? 'no_pro_available' : 'cancelled';
  }
  // Legacy failed-match terminal states (pre-unified-dispatch rows). The new
  // flow no longer produces status='no_pro_available'; kept for old rows.
  if (d.status === 'no_pro_available') return 'no_pro_available';
  if (d.status === 'no_show') return 'no_show';
  if (d.completed_at) return 'completed';
  if (d.started_at) return 'in_progress';
  if (d.arrived_at) return 'arrived';
  if (d.en_route_at) return 'en_route';
  if (d.helper_id) return 'assigned';
  return 'dispatching';
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontMono:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold', letterSpacing: 0.4 };

const AMBER = '#F5A300';
const AMBER_LIGHT = '#FFC042';
const GREEN = '#22C55E';

// Sheet covers roughly the lower 58% of the screen and overlays the map.
const SHEET_HEIGHT = Math.round(SCREEN_H * 0.58);

// Default region — Bangalore-ish — used when no coords passed via params.
const DEFAULT_REGION: Region = {
  latitude: 12.9716,
  longitude: 77.5946,
  latitudeDelta: 0.012,
  longitudeDelta: 0.012,
};

// Dark map style — desaturated palette, hidden POIs, subtle road network so
// the amber route polyline reads cleanly.
const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0A1218' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5A6470' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0A1218' }] },
  { featureType: 'administrative', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#7A8590' }, { visibility: 'on' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0F1A22' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#101820' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#1A2530' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#0A1218' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#22303D' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#0A1218' }] },
  { featureType: 'road.arterial', elementType: 'geometry.fill', stylers: [{ color: '#1F2A36' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#07090C' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#3A4450' }] },
];

// ── Screen ──────────────────────────────────────────────────────────────────

export default function TrackLiveScreen() {
  const { isDark } = useTheme();
  const c = useC();
  const styles = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  // Success green: dark brand green kept exact; light uses a readable deep green.
  const success = isDark ? GREEN : c.green;
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'TrackLive'>>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { startPayment, pollStatus } = useCashfreePayment();
  const [paying, setPaying] = useState(false);

  const params = route.params || ({} as MainStackParamList['TrackLive']);
  const {
    bookingId,
    serviceName,
    helperName: paramHelperName,
    helperPhone: paramHelperPhone,
    helperRating: paramHelperRating,
    helperJobs: paramHelperJobs,
    distanceKm: paramDistanceKm,
    otp,
    createdAt,
    acceptedAt: paramAcceptedAt,
  } = params;

  // Booking detail drives the entire screen. Fetched on mount + on focus +
  // whenever a booking_status_change push arrives for this booking. We keep
  // route params as a first-paint fallback so the user never sees a blank
  // screen during the initial fetch.
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDetail = useCallback(async () => {
    if (!bookingId || !token || token === '__guest__') return;
    try {
      const d = await getBookingDetail(token, bookingId);
      setDetail(d);
    } catch {
      // Keep prior detail rather than blanking. Network blips are recoverable
      // on the next focus / event tick.
    } finally {
      setLoading(false);
    }
  }, [bookingId, token]);

  // Pay-online nudge: reuse the Cashfree direct-order rail. On success we poll
  // the gateway then refetch — the webhook stamps payment_status='paid', which
  // unhides the END OTP and removes the nudge.
  const payOnline = useCallback(async () => {
    if (!bookingId || !token || token === '__guest__' || paying) return;
    setPaying(true);
    try {
      const order = await createCashfreeOrder(token, {
        booking_id: bookingId,
        payment_source: 'direct',
      });
      await startPayment({
        payment_session_id: order.payment_session_id,
        order_id: order.order_id,
        on_success: async () => {
          try {
            await pollStatus(order.order_id);
          } catch {
            // poll timeout/abort — the focus refetch will still pick up the
            // webhook-stamped paid state shortly.
          }
          await fetchDetail();
        },
        on_failure: () => {
          // sheet closed / failed — leave the nudge in place.
        },
      });
    } catch (err) {
      showError(
        err instanceof CashfreeOrderError ? err.message : "Couldn't start payment. Try again.",
      );
    } finally {
      setPaying(false);
    }
  }, [bookingId, token, paying, startPayment, pollStatus, fetchDetail]);

  // Initial fetch + refetch on focus (handles return from background).
  useFocusEffect(
    useCallback(() => {
      fetchDetail();
    }, [fetchDetail]),
  );

  // Subscribe to FCM-driven status changes. pushRouter emits
  // booking_status_change for pro_en_route / pro_arrived / job_started /
  // job_completed (and any future variants). We refetch detail rather than
  // trust the payload — the wire is best-effort, the DB is the source of
  // truth.
  useEffect(() => {
    const unsub = onShiftEvent((ev) => {
      if (ev.type !== 'booking_status_change') return;
      if (ev.booking_id !== bookingId) return;
      fetchDetail();
    });
    return unsub;
  }, [bookingId, fetchDetail]);

  const subState = useMemo<SubState>(() => deriveSubState(detail), [detail]);

  // Resolve display fields preferring the freshest source: live detail >
  // route params > generic fallback.
  const helperName = detail?.helper?.name ?? paramHelperName;
  const helperPhone = detail?.helper?.phone ?? paramHelperPhone;
  const helperRating = detail?.helper?.rating ?? paramHelperRating;
  const helperJobs = detail?.helper?.total_jobs ?? paramHelperJobs;
  const acceptedAt = detail?.accepted_at ?? paramAcceptedAt;
  const displayHelperName = helperName ?? 'Your pro';

  // Call is enabled only once the pro is en_route or later. The backend
  // returns a middle-masked phone pre-accept; tel: would dial garbage.
  const callEnabled =
    !!helperPhone &&
    (subState === 'en_route' ||
      subState === 'arrived' ||
      subState === 'in_progress');

  const onCallPro = () => {
    if (!callEnabled || !helperPhone) {
      showError('You can call when your pro is on the way');
      return;
    }
    Linking.openURL(`tel:${helperPhone.replace(/\s+/g, '')}`).catch(() => {});
  };
  const onMessagePro = () => {
    if (!bookingId) return;
    navigation.navigate('Chat', { bookingId, helperName });
  };

  // ── Failed-match recovery actions ─────────────────────────────────────────
  // The unified flow's terminal failed-match panels (no_pro_available, no_show)
  // are all already terminal server-side, so they just route home — no in-screen
  // cancel/keep-looking action remains (those belonged to the deleted
  // pending_customer_action limbo, spec §9).
  const goHome = () => navigation.navigate('Tabs', { screen: 'Home' });

  // Live tracking via WebSocket. Server pushes a TrackingResponse JSON every
  // ~5s on this socket — replaces the previous setInterval poll. Saves mobile
  // battery + signaling overhead (single persistent TCP vs new HTTP every 5s).
  const [tracking, setTracking] = useState<TrackingResponse | null>(null);

  useEffect(() => {
    if (!bookingId || !token || token === '__guest__') return;
    let alive = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const connect = () => {
      if (!alive) return;
      try {
        ws = new WebSocket(getBookingTrackingWsUrl(bookingId));
      } catch {
        return; // bad URL (e.g. http:// in production) — leave tracking null
      }

      ws.onopen = () => {
        try {
          ws?.send(JSON.stringify({ type: 'auth', token }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const raw = typeof ev.data === 'string' ? ev.data : '';
          const msg = JSON.parse(raw);
          if (msg && typeof msg === 'object' && 'helper_lat' in msg) {
            if (alive) setTracking(msg as TrackingResponse);
          }
          // Server emits {"error": ...} on auth/booking-state failures and
          // closes; reconnect logic below handles transient cases.
        } catch {}
      };

      const scheduleReconnect = () => {
        if (!alive) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15000);
      };

      ws.onerror = scheduleReconnect;
      ws.onclose = scheduleReconnect;
    };

    connect();
    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try { ws.close(); } catch {}
      }
    };
  }, [bookingId, token]);

  // Memoize coord objects so their reference identity is stable when the
  // underlying lat/lng values don't change — lets dependent hooks list
  // `proCoord` / `homeCoord` directly (satisfies exhaustive-deps) without
  // re-firing on every render. Pull values into locals so the hook body
  // doesn't reference `tracking` (avoids spurious dep warning).
  const helperLat = tracking?.helper_lat;
  const helperLng = tracking?.helper_lng;
  const customerLat = tracking?.customer_lat;
  const customerLng = tracking?.customer_lng;
  const proCoord = useMemo(
    () =>
      // Reject (0,0) as well as undefined: the backend tracking fallback
      // returns 0/0 for a pro who has not yet streamed any GPS. (0,0) is the
      // Gulf of Guinea, so plotting it drops the marker an ocean away and
      // fits the map across ~8000 km. No real pro is ever at exactly 0,0.
      helperLat !== undefined && helperLng !== undefined && (helperLat !== 0 || helperLng !== 0)
        ? { latitude: helperLat, longitude: helperLng }
        : null,
    [helperLat, helperLng],
  );
  const homeCoord = useMemo(
    () =>
      customerLat !== undefined && customerLng !== undefined
        ? { latitude: customerLat, longitude: customerLng }
        : null,
    [customerLat, customerLng],
  );

  // ETA placeholder until live GPS sharing ships. Refine in Phase X.
  // tracking.eta_minutes is backend-computed when the WS lands; otherwise
  // we fall back to the route param (set by BookingConfirmed) and finally
  // a 6-minute stub so the UI never shows a missing value.
  const etaMinutes = Math.max(0, Math.round(tracking?.eta_minutes ?? params.etaMinutes ?? 6));
  // distanceKm is only known once the WS lands or the route param explicitly
  // supplies one. We avoid the previous "1.2" default so the pin pill never
  // shows fabricated distance text before tracking arrives.
  const distanceKm: number | undefined = tracking
    ? haversineKm(
        tracking.helper_lat,
        tracking.helper_lng,
        tracking.customer_lat,
        tracking.customer_lng,
      )
    : paramDistanceKm;

  // Region: zoom around the midpoint between pro and home. Falls back to a
  // sensible default while the first tracking response is in flight.
  const region: Region = useMemo(() => {
    if (proCoord && homeCoord) {
      const minLat = Math.min(proCoord.latitude, homeCoord.latitude);
      const maxLat = Math.max(proCoord.latitude, homeCoord.latitude);
      const minLng = Math.min(proCoord.longitude, homeCoord.longitude);
      const maxLng = Math.max(proCoord.longitude, homeCoord.longitude);
      const padLat = Math.max(0.004, (maxLat - minLat) * 1.6);
      const padLng = Math.max(0.004, (maxLng - minLng) * 1.6);
      return {
        latitude: (minLat + maxLat) / 2,
        longitude: (minLng + maxLng) / 2,
        latitudeDelta: padLat,
        longitudeDelta: padLng,
      };
    }
    return DEFAULT_REGION;
  }, [proCoord, homeCoord]);

  // Decode the backend-supplied driving polyline once per tracking update.
  // Falls back to a straight pro→home line if decoding fails or polyline is
  // empty.
  const routePoints = useMemo(() => {
    if (!tracking?.polyline || !proCoord || !homeCoord) {
      return proCoord && homeCoord ? [proCoord, homeCoord] : [];
    }
    try {
      return polyline
        .decode(tracking.polyline)
        .map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
    } catch {
      return [proCoord, homeCoord];
    }
  }, [tracking?.polyline, proCoord, homeCoord]);

  const mapRef = useRef<any>(null);

  // Animate to fit both points the first time tracking lands.
  const fittedOnceRef = useRef(false);
  useEffect(() => {
    if (proCoord && homeCoord && !fittedOnceRef.current) {
      fittedOnceRef.current = true;
      mapRef.current?.fitToCoordinates([proCoord, homeCoord], {
        edgePadding: { top: 120, bottom: SHEET_HEIGHT + 60, left: 60, right: 60 },
        animated: true,
      });
    }
  }, [proCoord, homeCoord]);

  // START OTP comes from the server (detail.otp); route-param `otp` is a
  // first-paint fallback. END OTP only arrives when paid (server-gated).
  const startOtp = (detail?.otp ?? otp ?? '').padStart(4, '0').slice(0, 4);
  const endOtp = detail?.end_otp ?? '';
  const isPaid = detail?.payment_status === 'paid';
  const outstandingPaise = detail
    ? Math.max(
        0,
        (detail.price_paise ?? 0) - (detail.discount_paise ?? 0) - (detail.wallet_applied_paise ?? 0),
      )
    : 0;
  const isActive =
    subState !== 'completed' &&
    subState !== 'cancelled' &&
    subState !== 'no_pro_available' &&
    subState !== 'no_show';
  const initial = (helperName || displayHelperName || 'P')[0].toUpperCase();
  const shortId = bookingId
    ? `ZM-${bookingId.replace(/-/g, '').slice(0, 4).toUpperCase()}`
    : 'ZM-0000';

  const recenter = () => {
    if (proCoord && homeCoord) {
      mapRef.current?.fitToCoordinates([proCoord, homeCoord], {
        edgePadding: { top: 120, bottom: SHEET_HEIGHT + 60, left: 60, right: 60 },
        animated: true,
      });
    } else {
      mapRef.current?.animateToRegion(region, 600);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* MAP — fills full screen, sheet overlays it. */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        initialRegion={region}
        customMapStyle={DARK_MAP_STYLE}
        showsCompass={false}
        showsMyLocationButton={false}
        showsPointsOfInterests={false}
        showsBuildings={false}
        showsTraffic={false}
        showsIndoors={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
      >
        {/* Route — backend-supplied driving polyline; falls back to a
            straight pro→home line when none provided. */}
        {routePoints.length >= 2 && (
          <Polyline
            coordinates={routePoints}
            strokeColor={AMBER}
            strokeWidth={5}
            lineCap="round"
          />
        )}

        {/* Pro pulsing marker */}
        {proCoord && (
          <Marker
            coordinate={proCoord}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={Platform.OS === 'ios'}
          >
            <View
              style={{ width: 80, height: 80, alignItems: 'center', justifyContent: 'center' }}
            >
              <PulseHalo size={70} insetSize={70} />
              <PulseHalo size={70} insetSize={48} delay={400} />
              <View style={styles.proMarker}>
                <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 14 }]}>{initial}</Text>
              </View>
            </View>
          </Marker>
        )}

        {/* Pro location pill — only render when we know who the pro is and
            how far away they are. Avoids "Your pro · undefined km" flicker. */}
        {proCoord && helperName && distanceKm !== undefined && (
          <Marker
            coordinate={proCoord}
            anchor={{ x: 0.5, y: 1 }}
            tracksViewChanges={false}
            style={{ marginTop: -50 }}
          >
            <View style={styles.pinPill}>
              <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 11 }]}>
                {helperName.split(' ')[0]} · {distanceKm.toFixed(1)} km
              </Text>
            </View>
          </Marker>
        )}

        {/* Home destination */}
        {homeCoord && (
          <Marker coordinate={homeCoord} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}>
            <View style={{ alignItems: 'center' }}>
              <View style={styles.homeBubble}>
                <Feather name="home" size={14} color={AMBER} />
              </View>
              <View style={styles.homeTip} />
            </View>
          </Marker>
        )}
      </MapView>

      {/* Floating top bar */}
      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
        >
          <Feather name="chevron-left" size={20} color="#FFFFFF" />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={recenter}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
        >
          <Feather name="crosshair" size={18} color="#FFFFFF" />
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('HelpSupport')}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
        >
          <Feather name="help-circle" size={18} color="#FFFFFF" />
        </Pressable>
      </View>

      {/* Top status pill — copy varies by sub-state. Hidden for terminal /
          pre-assignment states where there's nothing live to show. */}
      {(subState === 'assigned' ||
        subState === 'en_route' ||
        subState === 'arrived' ||
        subState === 'in_progress') && (
        <View style={[styles.etaWrap, { top: insets.top + 60 }]}>
          <View style={styles.eta}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <BlinkDot />
              <Text style={[fontExtra, styles.etaLive]}>LIVE</Text>
            </View>
            {subState === 'en_route' && (
              <>
                <Text style={[fontBold, { color: '#FFFFFF', fontSize: 12.5 }]}>Arriving in </Text>
                <Text style={[fontExtra, { color: AMBER, fontSize: 13 }]}>~{etaMinutes} min</Text>
              </>
            )}
            {subState === 'arrived' && (
              <Text style={[fontBold, { color: '#FFFFFF', fontSize: 12.5 }]}>Pro has arrived</Text>
            )}
            {subState === 'assigned' && (
              <Text style={[fontBold, { color: '#FFFFFF', fontSize: 12.5 }]}>Pro assigned</Text>
            )}
            {subState === 'in_progress' && (
              <Text style={[fontBold, { color: '#FFFFFF', fontSize: 12.5 }]}>Service in progress</Text>
            )}
          </View>
        </View>
      )}

      {/* Bottom sheet — overlays the map. Content varies by sub-state. */}
      <View style={[styles.sheet, { height: SHEET_HEIGHT, paddingBottom: 24 + insets.bottom }]}>
        {/* Completed: the same green+amber success glow BookingConfirmed uses,
            clipped to the sheet's rounded top so both tick screens match. */}
        {subState === 'completed' && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              overflow: 'hidden',
            }}
          >
            <SuccessBackdrop isDark={isDark} />
          </View>
        )}
        <View style={styles.grab} />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Dispatching: no pro yet. Spinner + reassuring copy. */}
          {subState === 'dispatching' && (
            <View style={styles.statePanel}>
              <ActivityIndicator size="large" color={c.amber} />
              <Text style={[fontBold, styles.stateHeadline]}>ZopMop is finding a pro for you...</Text>
              <Text style={[fontMed, styles.stateSub]}>Most bookings confirm in under 30 seconds</Text>
            </View>
          )}

          {/* Cancelled: terminal alt-state. Surfaces a Book again CTA. */}
          {subState === 'cancelled' && (
            <View style={styles.statePanel}>
              <View style={styles.cancelIcon}>
                <Feather name="x" size={28} color={isDark ? '#FFFFFF' : c.danger} />
              </View>
              <Text style={[fontBold, styles.stateHeadline]}>Booking cancelled</Text>
              <Text style={[fontMed, styles.stateSub]}>
                You can request a new pro any time
              </Text>
              <PressFx
                onPress={() => navigation.navigate('Tabs', { screen: 'Home' })}
                style={styles.primaryCta}
              >
                <Text style={[fontBold, { color: '#0D0D0F', fontSize: 14 }]}>Book again</Text>
              </PressFx>
            </View>
          )}

          {/* No pros available: dispatch exhausted the pool. Terminal. */}
          {subState === 'no_pro_available' && (
            <View style={styles.statePanel}>
              <View style={styles.warnIcon}>
                <Feather name="alert-triangle" size={26} color={isDark ? '#FFFFFF' : c.amber} />
              </View>
              <Text style={[fontBold, styles.stateHeadline]}>No pros available right now</Text>
              <Text style={[fontMed, styles.stateSub]}>
                We couldn't find a pro nearby for your booking. This can happen
                during peak hours or in newer service areas.
              </Text>
              <PressFx onPress={goHome} style={styles.primaryCta}>
                <Text style={[fontBold, { color: '#0D0D0F', fontSize: 14 }]}>Try again</Text>
              </PressFx>
              <PressFx onPress={goHome} style={styles.secondaryCta}>
                <Text style={[fontSemi, styles.secondaryCtaText]}>Back to home</Text>
              </PressFx>
            </View>
          )}

          {/* No-show: assigned pro never arrived. Terminal, no charge. */}
          {subState === 'no_show' && (
            <View style={styles.statePanel}>
              <View style={styles.warnIcon}>
                <Feather name="user-x" size={26} color={isDark ? '#FFFFFF' : c.amber} />
              </View>
              <Text style={[fontBold, styles.stateHeadline]}>Pro didn't show up</Text>
              <Text style={[fontMed, styles.stateSub]}>
                Your assigned pro didn't arrive. You haven't been charged.
              </Text>
              <PressFx onPress={goHome} style={styles.primaryCta}>
                <Text style={[fontBold, { color: '#0D0D0F', fontSize: 14 }]}>Find another pro</Text>
              </PressFx>
              <PressFx
                onPress={() => navigation.navigate('HelpSupport')}
                style={styles.secondaryCta}
              >
                <Text style={[fontSemi, styles.secondaryCtaText]}>Contact support</Text>
              </PressFx>
            </View>
          )}

          {/* Pro row — visible from `assigned` onwards (skip on dispatching /
              cancelled where there's no helper context). */}
          {(subState === 'assigned' ||
            subState === 'en_route' ||
            subState === 'arrived' ||
            subState === 'in_progress' ||
            subState === 'completed') && (
            <View style={styles.proRow}>
              <View style={styles.proAvatar}>
                <Text style={[fontExtra, { color: '#0D0D0F', fontSize: 18 }]}>{initial}</Text>
                <View style={styles.verify}>
                  <Feather name="check" size={10} color="#FFFFFF" />
                </View>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[fontBold, styles.pname]} numberOfLines={1}>
                    {displayHelperName}
                  </Text>
                </View>
                <View style={styles.metaRow}>
                  {(helperRating !== undefined || helperJobs !== undefined) && (
                    <>
                      <Feather name="star" size={11} color={c.amber} />
                      <Text style={[fontSemi, styles.metaText]}>
                        {[
                          helperRating !== undefined ? helperRating.toFixed(1) : null,
                          helperJobs !== undefined ? `${helperJobs} jobs` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                      <View style={styles.metaDot} />
                    </>
                  )}
                  <Text style={[fontSemi, styles.metaText]}>{serviceName ?? 'Cleaning'}</Text>
                </View>
              </View>
              {/* Hide chat + call once the job is complete — no longer
                  actionable. Disabled call shows toast hint pre-en_route. */}
              {subState !== 'completed' && (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <PressFx onPress={onMessagePro} style={[styles.proAction, styles.proActionGhost]}>
                    <Feather name="message-circle" size={16} color={c.text} />
                  </PressFx>
                  <PressFx
                    onPress={onCallPro}
                    style={[styles.proAction, styles.proActionPrimary, !callEnabled && { opacity: 0.5 }]}
                  >
                    <Feather name="phone" size={16} color="#0D0D0F" />
                  </PressFx>
                </View>
              )}
            </View>
          )}

          {/* Assigned-state hint: pro can't call yet. */}
          {subState === 'assigned' && (
            <Text style={[fontMed, styles.assignedHint]}>
              Your pro will start heading to you shortly
            </Text>
          )}

          {/* START OTP — shown once the pro is en-route, stays through the job
              so the pro can read it at the door. Server-issued. */}
          {!!startOtp &&
            (subState === 'en_route' || subState === 'arrived' || subState === 'in_progress') && (
              <View style={styles.otp}>
                <View style={{ flex: 1 }}>
                  <Text style={[fontBold, styles.otpLabel]}>START OTP</Text>
                  <Text style={[fontMed, styles.otpHelp]}>
                    {helperName
                      ? `Share with ${helperName.split(' ')[0]} when they arrive`
                      : 'Share this code with your pro when they arrive'}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {startOtp.split('').map((d, i) => (
                    <View key={i} style={styles.otpDigit}>
                      <Text style={[fontMono, styles.otpDigitText]}>{d}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

          {/* Pay-online nudge — present while the booking is active and unpaid.
              Paying online (or the pro collecting cash) flips payment_status to
              'paid', which removes this row and reveals the END OTP. */}
          {isActive && !isPaid && (
            <Pressable style={styles.payNudge} onPress={payOnline} disabled={paying}>
              <View style={styles.payNudgeIcon}>
                <Text style={[fontBold, styles.payNudgeRupee]}>₹</Text>
              </View>
              <Text style={[fontMed, styles.payNudgeText]}>
                {`Pay ₹${(outstandingPaise / 100).toFixed(0)} online to avoid cash handling`}
              </Text>
              <Text style={[fontMed, styles.payNudgeChevron]}>›</Text>
            </Pressable>
          )}

          {/* END OTP — only once paid, during the job. Shared to finish. */}
          {isPaid && !!endOtp && subState === 'in_progress' && (
            <View style={styles.otp}>
              <View style={{ flex: 1 }}>
                <Text style={[fontBold, styles.otpLabel]}>END OTP</Text>
                <Text style={[fontMed, styles.otpHelp]}>
                  Share when the job is done to finish
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {endOtp.split('').map((d, i) => (
                  <View key={i} style={styles.otpDigit}>
                    <Text style={[fontMono, styles.otpDigitText]}>{d}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Task checklist — in-progress only. Lists every booking_service
              row with its per-service status. */}
          {subState === 'in_progress' && detail && detail.services.length > 0 && (
            <View style={styles.taskList}>
              <Text style={[fontBold, styles.sectionHeader]}>Tasks</Text>
              {detail.services.map((s) => (
                <View key={s.service_id} style={styles.taskRow}>
                  <View
                    style={[
                      styles.taskBullet,
                      s.status === 'completed' && { backgroundColor: success },
                      s.status === 'in_progress' && { backgroundColor: c.amber },
                      s.status === 'skipped' && { backgroundColor: c.glassBorderHi },
                    ]}
                  >
                    {s.status === 'completed' && <Feather name="check" size={11} color="#FFFFFF" />}
                    {s.status === 'in_progress' && <Feather name="clock" size={11} color="#0D0D0F" />}
                    {s.status === 'skipped' && <Feather name="minus" size={11} color={c.textSecondary} />}
                  </View>
                  <Text
                    style={[
                      fontMed,
                      styles.taskName,
                      s.status === 'skipped' && { textDecorationLine: 'line-through', opacity: 0.5 },
                    ]}
                  >
                    {s.service_name}
                  </Text>
                  <Text style={[fontMono, styles.taskDuration]}>{s.duration_minutes} min</Text>
                </View>
              ))}
            </View>
          )}

          {/* Completed: hide steps, surface the Service-Complete view. */}
          {subState === 'completed' && (
            <ServiceComplete
              helperName={helperName}
              priceText={detail ? `₹${(detail.price_paise / 100).toFixed(0)}` : undefined}
              onSubmit={async (stars, text) => {
                if (!bookingId || !token || token === '__guest__') return;
                await submitBookingReview(token, bookingId, stars, text);
              }}
              onDone={() => navigation.navigate('Tabs', { screen: 'Bookings' })}
              onSkip={() => navigation.navigate('Tabs', { screen: 'Bookings' })}
            />
          )}

          {/* Lifecycle steps — visible for the active progression. Hidden
              when the journey is over (completed / cancelled) or hasn't
              started (dispatching). */}
          {(subState === 'assigned' ||
            subState === 'en_route' ||
            subState === 'arrived' ||
            subState === 'in_progress') && (
            <View style={{ marginTop: 18, paddingHorizontal: 20 }}>
              <Step
                c={c}
                isDark={isDark}
                styles={styles}
                success={success}
                state="done"
                icon="check"
                title="Booking confirmed"
                sub={buildAcceptedSub(helperName, createdAt, acceptedAt)}
                time={acceptedAt ? formatTime(acceptedAt) : '—'}
                connectorBelow="solid-green"
              />
              <Step
                c={c}
                isDark={isDark}
                styles={styles}
                success={success}
                state={
                  subState === 'en_route'
                    ? 'active'
                    : subState === 'arrived' || subState === 'in_progress'
                    ? 'done'
                    : 'pending'
                }
                icon="clock"
                title={subState === 'en_route' ? 'On the way' : 'En route'}
                sub={
                  subState === 'en_route'
                    ? distanceKm !== undefined
                      ? `${distanceKm.toFixed(1)} km · ${etaMinutes} min remaining`
                      : `${etaMinutes} min remaining`
                    : subState === 'assigned'
                    ? 'Your pro will start heading to you shortly'
                    : 'Reached your location'
                }
                time={subState === 'en_route' ? formatNow() : detail?.en_route_at ? formatTime(detail.en_route_at) : '—'}
                timeAccent={subState === 'en_route'}
                connectorBelow={subState === 'en_route' ? 'amber-fade' : subState === 'assigned' ? 'muted' : 'solid-green'}
              />
              <Step
                c={c}
                isDark={isDark}
                styles={styles}
                success={success}
                state={
                  subState === 'arrived'
                    ? 'active'
                    : subState === 'in_progress'
                    ? 'done'
                    : 'pending'
                }
                icon="home"
                title={subState === 'in_progress' ? 'Service in progress' : 'Arrived & started'}
                sub={
                  subState === 'arrived'
                    ? 'Share OTP to begin'
                    : subState === 'in_progress'
                    ? 'Your pro is working on the task list'
                    : `~${addMinutes(etaMinutes)}`
                }
                time={detail?.arrived_at ? formatTime(detail.arrived_at) : '—'}
                timeAccent={subState === 'arrived'}
                connectorBelow="muted"
              />
              <Step
                c={c}
                isDark={isDark}
                styles={styles}
                success={success}
                state="pending"
                icon="check"
                title="Service completed"
                sub="Rate your pro after the service"
                time={'—'}
              />
            </View>
          )}

          {/* Booking ID footer — always visible. */}
          <View style={{ alignItems: 'center', marginTop: 20 }}>
            <View style={styles.bkIdPill}>
              <Text style={[fontMono, styles.bkIdText]}>#{shortId}</Text>
            </View>
          </View>

          {loading && !detail && (
            <View style={{ alignItems: 'center', marginTop: 12 }}>
              <ActivityIndicator size="small" color={c.amber} />
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

// ── Animated bits ────────────────────────────────────────────────────────────

function PulseHalo({
  size,
  delay = 0,
  insetSize,
}: {
  size: number;
  delay?: number;
  insetSize?: number;
}) {
  const scale = useSharedValue(0.8);
  const opacity = useSharedValue(1);
  useEffect(() => {
    scale.value = withRepeat(
      withTiming(1.6, { duration: 2000, easing: Easing.out(Easing.cubic) }),
      -1,
      false,
    );
    opacity.value = withRepeat(
      withTiming(0, { duration: 2000, easing: Easing.linear }),
      -1,
      false,
    );
  }, [delay, scale, opacity]);
  const aStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));
  const dim = insetSize ?? size;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          width: dim,
          height: dim,
          borderRadius: dim / 2,
          backgroundColor: insetSize && insetSize !== size
            ? 'rgba(245,163,0,0.45)'
            : 'rgba(245,163,0,0.25)',
        },
        aStyle,
      ]}
    />
  );
}

function BlinkDot() {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.35, { duration: 700, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [opacity]);
  const aStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[
        { width: 6, height: 6, borderRadius: 3, backgroundColor: GREEN },
        aStyle,
      ]}
    />
  );
}

// ── Step row ─────────────────────────────────────────────────────────────────

type StepState = 'done' | 'active' | 'pending';
type Connector = 'solid-green' | 'amber-fade' | 'muted';

function Step({
  c,
  isDark,
  styles,
  success,
  state,
  icon,
  title,
  sub,
  time,
  timeAccent,
  connectorBelow,
}: {
  c: ScreenColors;
  isDark: boolean;
  styles: ReturnType<typeof makeStyles>;
  success: string;
  state: StepState;
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  sub: string;
  time: string;
  timeAccent?: boolean;
  connectorBelow?: Connector;
}) {
  // Animate marker scale + opacity when this step lights up. Pending starts
  // small and dim; on advance to active/done it pops in via spring.
  const scale = useSharedValue(state === 'pending' ? 0.85 : 1);
  const op = useSharedValue(state === 'pending' ? 0.55 : 1);
  useEffect(() => {
    scale.value = withSpring(state === 'pending' ? 0.85 : 1, {
      damping: 12,
      stiffness: 180,
      mass: 0.7,
    });
    op.value = withTiming(state === 'pending' ? 0.55 : 1, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    });
  }, [state, scale, op]);
  const markerAStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: op.value,
  }));

  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 12,
        alignItems: 'flex-start',
        paddingVertical: 10,
        position: 'relative',
      }}
    >
      {/* Connector line below marker */}
      {connectorBelow && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 13,
            top: 32,
            bottom: -10,
            width: 2,
            backgroundColor:
              connectorBelow === 'solid-green'
                ? success
                : connectorBelow === 'muted'
                ? c.glassBorderHi
                : 'transparent',
          }}
        >
          {connectorBelow === 'amber-fade' && (
            <View style={StyleSheet.absoluteFill}>
              <View style={{ flex: 0.2, backgroundColor: c.amber }} />
              <View style={{ flex: 0.8, backgroundColor: 'rgba(245,163,0,0.10)' }} />
            </View>
          )}
        </View>
      )}

      <Animated.View
        style={[
          styles.marker,
          state === 'done' && { backgroundColor: success },
          state === 'active' && {
            backgroundColor: c.amber,
            shadowColor: c.amber,
            shadowOpacity: 0.5,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 0 },
            elevation: 6,
          },
          state === 'pending' && { backgroundColor: c.glass },
          markerAStyle,
        ]}
      >
        {state === 'active' && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: -4,
              left: -4,
              right: -4,
              bottom: -4,
              borderRadius: 20,
              borderWidth: 4,
              borderColor: 'rgba(245,163,0,0.25)',
            }}
          />
        )}
        <Feather
          name={icon}
          size={13}
          color={state === 'done' ? '#FFFFFF' : state === 'active' ? '#0D0D0F' : c.textMuted}
        />
      </Animated.View>
      <View style={{ flex: 1, paddingTop: 4 }}>
        <Text
          style={[
            fontBold,
            { color: c.text, fontSize: 13, letterSpacing: -0.07, lineHeight: 16 },
            state === 'pending' && { opacity: 0.5 },
          ]}
        >
          {title}
        </Text>
        <Text style={[fontMed, { color: c.textSecondary, fontSize: 11, marginTop: 2 }]}>
          {sub}
        </Text>
      </View>
      <Text
        style={[
          fontMono,
          {
            fontSize: 11,
            paddingTop: 5,
            color: timeAccent ? c.amber : c.textMuted,
          },
        ]}
      >
        {time}
      </Text>
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatNow(): string {
  const d = new Date();
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function buildAcceptedSub(
  helperName: string | undefined,
  createdAt: string | undefined,
  acceptedAt: string | undefined,
): string {
  const first = helperName ? helperName.split(' ')[0] : 'Your pro';
  if (!createdAt || !acceptedAt) {
    return `${first} accepted your booking`;
  }
  const created = new Date(createdAt).getTime();
  const accepted = new Date(acceptedAt).getTime();
  if (isNaN(created) || isNaN(accepted) || accepted < created) {
    return `${first} accepted your booking`;
  }
  const diffSec = Math.max(1, Math.round((accepted - created) / 1000));
  if (diffSec < 60) return `${first} accepted in ${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  return `${first} accepted in ${diffMin} min`;
}

function addMinutes(min: number): string {
  const d = new Date(Date.now() + min * 60_000);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors
// slate). Dark stays #0A0A0A + amber #F5A300 identical; light adds cream + amber.
// Floating chips/pins/route sit over a hardcoded-dark Google map (DARK_MAP_STYLE
// is unchanged in both themes), so their dark surfaces + white glyphs stay
// literal in both — theming them to cream would make them unreadable on the map.
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Success green: dark brand green kept exact; light uses a readable deep green.
  const success = isDark ? GREEN : c.green;
  // Map backdrop flash colour behind the map tiles — dark map base in dark,
  // cream in light so the brief pre-render flash matches the theme.
  const mapBg = isDark ? '#0A1218' : c.bg;
  // Bottom sheet surface (#0F0F11) has no useC equivalent → documented literal
  // in dark (identical); white card in light. `verify` ring matches it.
  const surface = isDark ? '#0F0F11' : c.white;
  // Sheet grab handle — bright white handle on dark sheet in dark; a subtle
  // ink hairline on the cream sheet in light.
  const grabColor = isDark ? 'rgba(255,255,255,0.18)' : c.glassBorderHi;
  // Cancel icon uses a soft red wash — exact literal in dark, danger tokens
  // in light so it reads on cream.
  const cancelBg = isDark ? 'rgba(255,90,90,0.18)' : c.dangerSoft;
  const cancelBorder = isDark ? 'rgba(255,90,90,0.4)' : c.dangerBorder;

  return StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: mapBg,
  },

  // Top bar
  topBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    gap: 10,
    zIndex: 30,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,22,0.85)',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },

  // ETA
  etaWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 30,
  },
  eta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(20,20,22,0.92)',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  etaLive: {
    fontSize: 10,
    color: GREEN,
    letterSpacing: 0.6,
  },

  // Pins
  pinPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.95)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  proMarker: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: AMBER,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: AMBER,
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  homeBubble: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#0D0D0F',
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  homeTip: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#FFFFFF',
    marginTop: -2,
  },

  // Sheet — pinned to bottom, overlays map
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 8,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: -12 },
    elevation: 24,
    borderTopWidth: 1,
    borderTopColor: c.glassBorder,
    zIndex: 40,
  },
  grab: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: grabColor,
    alignSelf: 'center',
    marginVertical: 6,
    marginBottom: 16,
  },

  // Pro row
  proRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
  },
  proAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: c.amber,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
    shadowColor: c.amber,
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  verify: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: success,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: surface,
  },
  pname: {
    color: c.text,
    fontSize: 16,
    letterSpacing: -0.32,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 99,
    backgroundColor: 'rgba(245,163,0,0.18)',
  },
  badgeText: {
    color: c.amber,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  metaText: {
    color: c.textSecondary,
    fontSize: 11.5,
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: c.textMuted,
  },
  proAction: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  proActionGhost: {
    backgroundColor: c.glassHi,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassBorder,
  },
  proActionPrimary: {
    backgroundColor: c.amber,
    shadowColor: c.amber,
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },

  // OTP card
  otp: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 14,
    marginHorizontal: 20,
    padding: 14,
    borderRadius: 16,
    backgroundColor: c.amberSoft,
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.45)',
    borderStyle: 'dashed',
  },
  otpLabel: {
    color: c.amber,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  otpHelp: {
    color: c.textSecondary,
    fontSize: 11.5,
    marginTop: 2,
  },
  otpDigit: {
    width: 28,
    height: 36,
    borderRadius: 8,
    backgroundColor: c.bg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.3)',
  },
  otpDigitText: {
    fontSize: 18,
    color: c.amber,
    letterSpacing: -0.3,
  },

  payNudge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    marginHorizontal: 20,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: c.amberSoft,
  },
  payNudgeIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: c.amber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payNudgeRupee: {
    color: '#FFFFFF',
    fontSize: 15,
  },
  payNudgeText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 13,
  },
  payNudgeChevron: {
    color: c.amber,
    fontSize: 20,
  },

  // Step marker
  marker: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },

  // Booking ID footer
  bkIdPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 99,
    backgroundColor: 'rgba(245,163,0,0.15)',
  },
  bkIdText: {
    color: c.amber,
    fontSize: 10,
    letterSpacing: -0.1,
  },

  // State panels (dispatching / cancelled)
  statePanel: {
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingTop: 14,
    gap: 10,
  },
  stateHeadline: {
    color: c.text,
    fontSize: 16,
    textAlign: 'center',
    marginTop: 8,
    letterSpacing: -0.2,
  },
  stateSub: {
    color: c.textSecondary,
    fontSize: 12.5,
    textAlign: 'center',
    lineHeight: 18,
  },
  cancelIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: cancelBg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: cancelBorder,
  },
  warnIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(245,163,0,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.4)',
  },
  primaryCta: {
    marginTop: 14,
    backgroundColor: c.amber,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryCta: {
    marginTop: 10,
    paddingHorizontal: 24,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryCtaText: {
    color: c.textSecondary,
    fontSize: 13,
  },

  assignedHint: {
    color: c.textSecondary,
    fontSize: 12,
    paddingHorizontal: 20,
    marginTop: 8,
  },

  // Task checklist (in_progress)
  taskList: {
    marginTop: 16,
    paddingHorizontal: 20,
  },
  sectionHeader: {
    color: c.textSecondary,
    fontSize: 11,
    letterSpacing: 0.8,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
  },
  taskBullet: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: c.glassHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskName: {
    flex: 1,
    color: c.text,
    fontSize: 13.5,
  },
  taskDuration: {
    color: c.textMuted,
    fontSize: 11,
  },

  // Rating panel (completed)
  });
}
