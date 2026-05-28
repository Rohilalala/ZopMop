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
  TouchableOpacity as TouchableOpacityRN,
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
import EndCodeCard from '../../components/payment/EndCodeCard';
import { useAuth } from '../../context/AuthContext';
import {
  getBookingTrackingWsUrl,
  getBookingDetail,
  submitBookingReview,
  type BookingDetail,
  type TrackingResponse,
} from '../../api/matching';
import { cancelBooking, keepLookingBooking } from '../../api/bookings';
import { onShiftEvent } from '../../utils/shiftEvents';
import { showSuccess, showError } from '../../utils/toast';
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
  | 'no_show'
  | 'pending_action';

function deriveSubState(d: BookingDetail | null): SubState {
  if (!d) return 'dispatching';
  if (d.status === 'cancelled') return 'cancelled';
  // Failed-match terminal/decision states. Backend (migration 101) emits
  // these when dispatch exhausts the pool, a pro no-shows, or the stealth
  // search window expires. Must come before the timestamp checks below so a
  // partially-stamped booking that later fails still surfaces the right UI.
  if (d.status === 'no_pro_available') return 'no_pro_available';
  if (d.status === 'no_show') return 'no_show';
  if (d.status === 'pending_customer_action') return 'pending_action';
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
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'TrackLive'>>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

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
  // Guards against double-tap while a request is in flight. `actionBusy`
  // disables every CTA on the failed-match panels.
  const [actionBusy, setActionBusy] = useState(false);

  const goHome = () => navigation.navigate('Tabs', { screen: 'Home' });

  // Keep Looking — only valid in pending_customer_action (stealth window
  // expired). Extends the search 15 min, then we refetch so the panel flips
  // back to the dispatching spinner.
  const onKeepLooking = async () => {
    if (!bookingId || !token || token === '__guest__' || actionBusy) return;
    setActionBusy(true);
    try {
      await keepLookingBooking(token, bookingId);
      showSuccess("We're looking again — hang tight");
      await fetchDetail();
    } catch (e) {
      showError((e as Error)?.message ?? 'Could not extend the search');
    } finally {
      setActionBusy(false);
    }
  };

  // Cancel — used by the pending_action panel's secondary CTA. no_pro_available
  // / no_show are already terminal server-side, so those panels just route
  // home rather than issue a redundant cancel.
  const onCancelBooking = async () => {
    if (!bookingId || !token || token === '__guest__' || actionBusy) return;
    setActionBusy(true);
    try {
      await cancelBooking(token, bookingId);
      goHome();
    } catch (e) {
      showError((e as Error)?.message ?? 'Could not cancel the booking');
      setActionBusy(false);
    }
  };

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
      helperLat !== undefined && helperLng !== undefined
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

  // Phase 1 Step 5c — real Start OTP. The WebSocket push surfaces
  // tracking.start_otp_code (backend Peek; self-heal at Step 5a.1).
  // Empty string = no code outstanding yet (either pre-MarkEnRoute or
  // the self-heal hasn't recovered after a Redis hiccup; next push
  // tick will retry). The legacy `otp` route param is kept only as a
  // first-paint fallback for the pre-WebSocket bookings; once
  // tracking lands the real code wins.
  const startOtpCode = (tracking?.start_otp_code && tracking.start_otp_code.length > 0)
    ? tracking.start_otp_code
    : (otp ?? '');
  // Legacy display path keeps the 4-digit + booking-id-hash fallback so
  // anywhere outside the new big-card render path still works.
  const displayOtp = (otp ?? deriveOtp(bookingId ?? '0000')).padStart(4, '0').slice(0, 4);
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
      <StatusBar barStyle="light-content" />

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
        <View style={styles.grab} />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Dispatching: no pro yet. Spinner + reassuring copy. */}
          {subState === 'dispatching' && (
            <View style={styles.statePanel}>
              <ActivityIndicator size="large" color={AMBER} />
              <Text style={[fontBold, styles.stateHeadline]}>ZopMop is finding a pro for you...</Text>
              <Text style={[fontMed, styles.stateSub]}>Most bookings confirm in under 30 seconds</Text>
            </View>
          )}

          {/* Cancelled: terminal alt-state. Surfaces a Book again CTA. */}
          {subState === 'cancelled' && (
            <View style={styles.statePanel}>
              <View style={styles.cancelIcon}>
                <Feather name="x" size={28} color="#FFFFFF" />
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
                <Feather name="alert-triangle" size={26} color="#FFFFFF" />
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
                <Feather name="user-x" size={26} color="#FFFFFF" />
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

          {/* Pending customer action: stealth search window expired. The
              customer decides — keep looking (extends 15 min) or cancel. */}
          {subState === 'pending_action' && (
            <View style={styles.statePanel}>
              <View style={styles.warnIcon}>
                <Feather name="clock" size={26} color="#FFFFFF" />
              </View>
              <Text style={[fontBold, styles.stateHeadline]}>Still looking for a pro</Text>
              <Text style={[fontMed, styles.stateSub]}>
                We haven't matched you with a pro yet. Want us to keep looking
                for a little longer?
              </Text>
              <PressFx
                onPress={onKeepLooking}
                style={[styles.primaryCta, actionBusy && { opacity: 0.5 }]}
              >
                <Text style={[fontBold, { color: '#0D0D0F', fontSize: 14 }]}>Keep looking</Text>
              </PressFx>
              <PressFx
                onPress={onCancelBooking}
                style={[styles.secondaryCta, actionBusy && { opacity: 0.5 }]}
              >
                <Text style={[fontSemi, styles.secondaryCtaText]}>Cancel booking</Text>
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
                      <Feather name="star" size={11} color={AMBER} />
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
                    <Feather name="message-circle" size={16} color="#FFFFFF" />
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

          {/* Phase 1 Step 5c — BIG Start OTP display. Mockup-style
              card (eos-payment-spec.html .endcode-card) — same visual
              vocabulary the End OTP uses in 5d, kept consistent so
              the customer recognises both as the same affordance.
              Renders when the pro is in transit AND the backend has
              issued the code (tracking.start_otp_code is non-empty).
              Hides once started_at is stamped (gate consumed). */}
          {(subState === 'en_route' || subState === 'arrived') && startOtpCode.length > 0 && (
            <View style={styles.startCodeCard}>
              <Text style={[fontBold, styles.startCodeLabel]}>START CODE</Text>
              <View style={styles.startCodeDigits}>
                {startOtpCode.split('').map((d, i) => (
                  <View key={i} style={styles.startCodeDigit}>
                    <Text style={[fontMono, styles.startCodeDigitText]}>{d}</Text>
                  </View>
                ))}
              </View>
              <Text style={[fontMed, styles.startCodeHelper]}>
                Show this code to your pro to start.
              </Text>
            </View>
          )}

          {/* Phase 1 Step 5c — payment expectation copy. Customer's
              mental-model cue: payment moved from before-matching to
              end-of-service (Step 1 blast-radius review). Lives on
              the in-progress state so it lands right when the
              customer might otherwise wonder "have I paid?"
              Hides once payment is resolved (paid OR cash) — the
              expectation has been met. */}
          {subState === 'in_progress'
            && detail?.payment_status !== 'paid'
            && !detail?.cash_collected_at && (
            <View style={styles.payExpectationCard}>
              <Feather name="info" size={14} color={AMBER} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text style={[fontBold, styles.payExpectationTitle]}>
                  You pay when the service is done
                </Text>
                <Text style={[fontMed, styles.payExpectationSub]}>
                  When you see your pro packing up, tap below to pay.
                </Text>
              </View>
            </View>
          )}

          {/* Phase 1 Step 5d.1 — "Pay for this service" CTA. Calm +
              available throughout in_progress per the planning gate
              (pro has no separate done-flag; customer is the one who
              observes the pro finishing). Hidden once payment
              resolves — at that point states 4a/4b take over below. */}
          {subState === 'in_progress'
            && detail?.payment_status !== 'paid'
            && !detail?.cash_collected_at && (
            <TouchableOpacityRN
              style={styles.payCtaBtn}
              onPress={() => {
                if (!bookingId) return;
                navigation.navigate('EndOfServicePayment', {
                  bookingId,
                  amountPaise: detail?.price_paise ?? 0,
                  helperName: helperName ?? undefined,
                });
              }}
              accessibilityRole="button"
            >
              <Text style={[fontExtra, styles.payCtaText]}>
                Pay for this service
              </Text>
              <Feather name="chevron-right" size={16} color="#0D0D0F" />
            </TouchableOpacityRN>
          )}

          {/* Phase 1 Step 5d — inline End OTP display after payment
              resolves. 4a (cash) shows the amber reminder; 4b (paid
              online) shows the green Paid chip. End code itself
              renders via the shared EndCodeCard component. */}
          {subState === 'in_progress' && detail?.payment_status === 'paid' && (
            <View style={styles.payResolvedChip}>
              <Feather name="check-circle" size={14} color={GREEN} />
              <Text style={[fontBold, styles.payResolvedChipText, { color: GREEN }]}>
                Paid ₹{Math.round((detail.price_paise ?? 0) / 100)}
              </Text>
            </View>
          )}
          {subState === 'in_progress' && !!detail?.cash_collected_at && detail?.payment_status !== 'paid' && (
            <View style={[styles.payResolvedChip, { borderColor: 'rgba(245,163,0,0.30)', backgroundColor: 'rgba(245,163,0,0.10)' }]}>
              <Feather name="credit-card" size={14} color={AMBER} />
              <Text style={[fontBold, styles.payResolvedChipText, { color: AMBER }]}>
                Hand ₹{Math.round((detail.price_paise ?? 0) / 100)} to {helperName ? helperName.split(' ')[0] : 'your pro'}
              </Text>
            </View>
          )}
          {subState === 'in_progress'
            && (detail?.payment_status === 'paid' || !!detail?.cash_collected_at)
            && !!tracking?.end_otp_code
            && tracking.end_otp_code.length > 0 && (
            <EndCodeCard
              code={tracking.end_otp_code}
              label="END CODE"
              helper={`Read this code to ${helperName ? helperName.split(' ')[0] : 'your pro'} so they can finish up.`}
            />
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
                      s.status === 'completed' && { backgroundColor: GREEN },
                      s.status === 'in_progress' && { backgroundColor: AMBER },
                      s.status === 'skipped' && { backgroundColor: 'rgba(255,255,255,0.15)' },
                    ]}
                  >
                    {s.status === 'completed' && <Feather name="check" size={11} color="#FFFFFF" />}
                    {s.status === 'in_progress' && <Feather name="clock" size={11} color="#0D0D0F" />}
                    {s.status === 'skipped' && <Feather name="minus" size={11} color="rgba(255,255,255,0.6)" />}
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

          {/* Completed: hide steps, surface inline rating + tip placeholder. */}
          {subState === 'completed' && (
            <RatingPanel
              helperName={helperName}
              priceText={detail ? `₹${(detail.price_paise / 100).toFixed(0)}` : undefined}
              onSubmit={async (stars, text) => {
                if (!bookingId || !token || token === '__guest__') return;
                try {
                  await submitBookingReview(token, bookingId, stars, text);
                  showSuccess('Thanks for your feedback!');
                  navigation.navigate('Tabs', { screen: 'Bookings' });
                } catch (e) {
                  showError((e as Error)?.message ?? 'Could not submit rating');
                }
              }}
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
                state="done"
                icon="check"
                title="Booking confirmed"
                sub={buildAcceptedSub(helperName, createdAt, acceptedAt)}
                time={acceptedAt ? formatTime(acceptedAt) : '—'}
                connectorBelow="solid-green"
              />
              <Step
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
                state="pending"
                icon="check"
                title="Service completed"
                sub="Rate your pro after the service"
                time={'—'}
              />
            </View>
          )}

          {/* Tip placeholder — visible on completed but disabled. Real
              tipping flow is post-MVP. */}
          {subState === 'completed' && (
            <View style={styles.tipPlaceholder}>
              <Feather name="dollar-sign" size={14} color="rgba(255,255,255,0.4)" />
              <Text style={[fontMed, { color: 'rgba(255,255,255,0.4)', fontSize: 12 }]}>
                Tip (coming soon)
              </Text>
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
              <ActivityIndicator size="small" color={AMBER} />
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

// ── Rating panel (inline) ────────────────────────────────────────────────────
// Inline (not modal) per UX choice: persistent, dismiss-resistant, fits the
// completed-state sheet space, measurably higher submission rate.

function RatingPanel({
  helperName,
  priceText,
  onSubmit,
  onSkip,
}: {
  helperName?: string;
  priceText?: string;
  onSubmit: (stars: number, comment: string) => Promise<void>;
  onSkip: () => void;
}) {
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = stars > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(stars, comment.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.ratingPanel}>
      <Text style={[fontExtra, styles.ratingHeadline]}>Service completed</Text>
      {priceText && (
        <Text style={[fontMed, styles.ratingSub]}>Total {priceText}</Text>
      )}
      <Text style={[fontBold, styles.ratingPrompt]}>
        Rate {helperName ? helperName.split(' ')[0] : 'your pro'}
      </Text>
      <View style={styles.starsRow}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => setStars(n)} hitSlop={6}>
            <Feather
              name="star"
              size={32}
              color={n <= stars ? AMBER : 'rgba(255,255,255,0.18)'}
              // @ts-ignore — Feather supports filled via overlay; use color only
            />
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.ratingInput}
        placeholder="Add your feedback (optional)"
        placeholderTextColor="rgba(255,255,255,0.35)"
        value={comment}
        onChangeText={setComment}
        multiline
        maxLength={500}
      />
      <PressFx
        onPress={submit}
        style={[styles.primaryCta, !canSubmit && { opacity: 0.4 }]}
        disabled={!canSubmit}
      >
        <Text style={[fontBold, { color: '#0D0D0F', fontSize: 14 }]}>
          {submitting ? 'Submitting…' : 'Submit rating'}
        </Text>
      </PressFx>
      <Pressable onPress={onSkip} hitSlop={6} style={{ marginTop: 10, alignSelf: 'center' }}>
        <Text style={[fontMed, { color: 'rgba(255,255,255,0.55)', fontSize: 13 }]}>
          Skip rating
        </Text>
      </Pressable>
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
  state,
  icon,
  title,
  sub,
  time,
  timeAccent,
  connectorBelow,
}: {
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
                ? GREEN
                : connectorBelow === 'muted'
                ? 'rgba(255,255,255,0.10)'
                : 'transparent',
          }}
        >
          {connectorBelow === 'amber-fade' && (
            <View style={StyleSheet.absoluteFill}>
              <View style={{ flex: 0.2, backgroundColor: AMBER }} />
              <View style={{ flex: 0.8, backgroundColor: 'rgba(245,163,0,0.10)' }} />
            </View>
          )}
        </View>
      )}

      <Animated.View
        style={[
          styles.marker,
          state === 'done' && { backgroundColor: GREEN },
          state === 'active' && {
            backgroundColor: AMBER,
            shadowColor: AMBER,
            shadowOpacity: 0.5,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 0 },
            elevation: 6,
          },
          state === 'pending' && { backgroundColor: 'rgba(255,255,255,0.06)' },
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
          color={state === 'done' ? '#FFFFFF' : state === 'active' ? '#0D0D0F' : 'rgba(255,255,255,0.4)'}
        />
      </Animated.View>
      <View style={{ flex: 1, paddingTop: 4 }}>
        <Text
          style={[
            fontBold,
            { color: '#FFFFFF', fontSize: 13, letterSpacing: -0.07, lineHeight: 16 },
            state === 'pending' && { opacity: 0.5 },
          ]}
        >
          {title}
        </Text>
        <Text style={[fontMed, { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2 }]}>
          {sub}
        </Text>
      </View>
      <Text
        style={[
          fontMono,
          {
            fontSize: 11,
            paddingTop: 5,
            color: timeAccent ? AMBER : 'rgba(255,255,255,0.4)',
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

function deriveOtp(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return String(h % 10000).padStart(4, '0');
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

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A1218',
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
    backgroundColor: '#0F0F11',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 8,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: -12 },
    elevation: 24,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    zIndex: 40,
  },
  grab: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
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
    backgroundColor: AMBER,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
    shadowColor: AMBER,
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
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0F0F11',
  },
  pname: {
    color: '#FFFFFF',
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
    color: AMBER,
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
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11.5,
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  proAction: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  proActionGhost: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  proActionPrimary: {
    backgroundColor: AMBER,
    shadowColor: AMBER,
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
    backgroundColor: 'rgba(245,163,0,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.45)',
    borderStyle: 'dashed',
  },
  otpLabel: {
    color: AMBER,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  otpHelp: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11.5,
    marginTop: 2,
  },
  otpDigit: {
    width: 28,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.3)',
  },
  otpDigitText: {
    fontSize: 18,
    color: AMBER,
    letterSpacing: -0.3,
  },

  // Phase 1 Step 5c — BIG Start OTP card. Tokens from
  // /tmp/eos-payment-spec.html .endcode-card (the End OTP treatment;
  // we use the same vocabulary for Start so customers recognise both
  // as the same affordance).
  startCodeCard: {
    marginTop: 18,
    marginHorizontal: 20,
    paddingVertical: 26,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: 'rgba(245,163,0,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.22)',
    alignItems: 'center',
  },
  startCodeLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: 'rgba(255,255,255,0.60)',
    marginBottom: 14,
    textTransform: 'uppercase',
  },
  startCodeDigits: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
  },
  startCodeDigit: {
    width: 42,
    height: 60,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  startCodeDigitText: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: '#FFFFFF',
  },
  startCodeHelper: {
    marginTop: 18,
    marginHorizontal: 28,
    textAlign: 'center',
    fontSize: 12.5,
    lineHeight: 17,
    color: 'rgba(255,255,255,0.5)',
  },

  // Phase 1 Step 5c — payment expectation copy card on in_progress.
  payExpectationCard: {
    marginTop: 14,
    marginHorizontal: 20,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(245,163,0,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.20)',
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  payExpectationTitle: {
    fontSize: 13,
    color: '#FFFFFF',
    letterSpacing: -0.1,
  },
  payExpectationSub: {
    fontSize: 11.5,
    marginTop: 2,
    color: 'rgba(255,255,255,0.55)',
    lineHeight: 16,
  },

  // Phase 1 Step 5d.1 — "Pay for this service" calm CTA.
  payCtaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    marginHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: '#F5A300',
  },
  payCtaText: {
    fontSize: 15,
    color: '#0D0D0F',
    letterSpacing: -0.2,
  },

  // Phase 1 Step 5d — resolved-payment chip (4a cash / 4b paid).
  payResolvedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 12,
    marginHorizontal: 20,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
    backgroundColor: 'rgba(34,197,94,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.28)',
  },
  payResolvedChipText: {
    fontSize: 12,
    letterSpacing: -0.1,
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
    color: AMBER,
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
    color: '#FFFFFF',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 8,
    letterSpacing: -0.2,
  },
  stateSub: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12.5,
    textAlign: 'center',
    lineHeight: 18,
  },
  cancelIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,90,90,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,90,90,0.4)',
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
    backgroundColor: AMBER,
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
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },

  assignedHint: {
    color: 'rgba(255,255,255,0.55)',
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
    color: 'rgba(255,255,255,0.6)',
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
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskName: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13.5,
  },
  taskDuration: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
  },

  // Rating panel (completed)
  ratingPanel: {
    marginTop: 6,
    marginHorizontal: 16,
    padding: 18,
    borderRadius: 18,
    backgroundColor: 'rgba(245,163,0,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(245,163,0,0.20)',
  },
  ratingHeadline: {
    color: AMBER,
    fontSize: 18,
    letterSpacing: -0.3,
  },
  ratingSub: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12.5,
    marginTop: 2,
  },
  ratingPrompt: {
    color: '#FFFFFF',
    fontSize: 14,
    marginTop: 14,
  },
  starsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    marginBottom: 14,
  },
  ratingInput: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: 'PlusJakartaSans_500Medium',
    minHeight: 60,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },

  tipPlaceholder: {
    marginTop: 14,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
});
