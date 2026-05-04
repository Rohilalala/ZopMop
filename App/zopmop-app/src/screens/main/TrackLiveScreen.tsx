// TrackLiveScreen — design-system port of `preview/tracking-screen.html`
// (dark · "On the way" variant only). Implements:
//   • Real Google Maps with custom dark / amber theme matching the design
//   • Pulsing pro avatar marker + home destination pin via custom Marker views
//   • Floating top bar (back / locate / help)
//   • ETA banner with blinking live dot
//   • Bottom sheet that overlays the map (~58% height), with internal scroll:
//     pro row, OTP card (start-job code), timeline steps, booking ID
//
// OTP "start-the-job" flow:
//   The customer sees a 4-digit OTP here. When the pro arrives, the customer
//   shares it; the pro enters it in their app, which flips the booking to
//   `started`. Until backend issues the OTP, we accept it via route param or
//   fall back to a deterministic stub derived from bookingId.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
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
import { useAuth } from '../../context/AuthContext';
import { getBookingTrackingWsUrl, type TrackingResponse } from '../../api/matching';
import polyline from '@mapbox/polyline';

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

  const params = route.params || ({} as MainStackParamList['TrackLive']);
  const {
    bookingId,
    serviceName,
    helperName = 'Priya M.',
    helperPhone,
    helperRating = 4.9,
    helperJobs = 312,
    distanceKm: paramDistanceKm = 1.2,
    otp,
  } = params;

  const onCallPro = () => {
    if (!helperPhone) return;
    Linking.openURL(`tel:${helperPhone.replace(/\s+/g, '')}`).catch(() => {});
  };
  const onMessagePro = () => {
    if (!bookingId) return;
    navigation.navigate('Chat', { bookingId, helperName });
  };

  // Live tracking via WebSocket. Server pushes a TrackingResponse JSON every
  // ~5s on this socket — replaces the previous setInterval poll. Saves mobile
  // battery + signaling overhead (single persistent TCP vs new HTTP every 5s).
  const { token } = useAuth();
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

  const proCoord = tracking
    ? { latitude: tracking.helper_lat, longitude: tracking.helper_lng }
    : null;
  const homeCoord = tracking
    ? { latitude: tracking.customer_lat, longitude: tracking.customer_lng }
    : null;

  const etaMinutes = Math.max(0, Math.round(tracking?.eta_minutes ?? params.etaMinutes ?? 6));
  const distanceKm = tracking
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
  }, [proCoord?.latitude, proCoord?.longitude, homeCoord?.latitude, homeCoord?.longitude]);

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
  }, [tracking?.polyline, proCoord?.latitude, homeCoord?.latitude]);

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
  }, [proCoord?.latitude, homeCoord?.latitude]);

  const displayOtp = (otp ?? deriveOtp(bookingId ?? '0000')).padStart(4, '0').slice(0, 4);
  const initial = (helperName || 'P')[0].toUpperCase();
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

        {/* Pro location pill */}
        {proCoord && (
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

      {/* ETA banner */}
      <View style={[styles.etaWrap, { top: insets.top + 60 }]}>
        <View style={styles.eta}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <BlinkDot />
            <Text style={[fontExtra, styles.etaLive]}>LIVE</Text>
          </View>
          <Text style={[fontBold, { color: '#FFFFFF', fontSize: 12.5 }]}>Arriving in </Text>
          <Text style={[fontExtra, { color: AMBER, fontSize: 13 }]}>~{etaMinutes} min</Text>
        </View>
      </View>

      {/* Bottom sheet — overlays the map */}
      <View style={[styles.sheet, { height: SHEET_HEIGHT, paddingBottom: 24 + insets.bottom }]}>
        <View style={styles.grab} />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Pro row */}
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
                  {helperName}
                </Text>
                <View style={styles.badge}>
                  <Text style={[fontExtra, styles.badgeText]}>TOP PRO</Text>
                </View>
              </View>
              <View style={styles.metaRow}>
                <Feather name="star" size={11} color={AMBER} />
                <Text style={[fontSemi, styles.metaText]}>
                  {helperRating.toFixed(1)} · {helperJobs} jobs
                </Text>
                <View style={styles.metaDot} />
                <Text style={[fontSemi, styles.metaText]}>{serviceName ?? 'Cleaning'}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <PressFx onPress={onMessagePro} style={[styles.proAction, styles.proActionGhost]}>
                <Feather name="message-circle" size={16} color="#FFFFFF" />
              </PressFx>
              <PressFx
                onPress={onCallPro}
                style={[styles.proAction, styles.proActionPrimary, !helperPhone && { opacity: 0.5 }]}
              >
                <Feather name="phone" size={16} color="#0D0D0F" />
              </PressFx>
            </View>
          </View>

          {/* OTP card */}
          <View style={styles.otp}>
            <View style={{ flex: 1 }}>
              <Text style={[fontBold, styles.otpLabel]}>START OTP</Text>
              <Text style={[fontMed, styles.otpHelp]}>
                Share with {helperName.split(' ')[0]} when she arrives
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {displayOtp.split('').map((d, i) => (
                <View key={i} style={styles.otpDigit}>
                  <Text style={[fontMono, styles.otpDigitText]}>{d}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Steps */}
          <View style={{ marginTop: 18, paddingHorizontal: 20 }}>
            <Step
              state="done"
              icon="check"
              title="Booking confirmed"
              sub={`${helperName.split(' ')[0]} accepted in 12 sec`}
              time="9:35 AM"
              connectorBelow="solid-green"
            />
            <Step
              state="active"
              icon="clock"
              title="On the way"
              sub={`${distanceKm.toFixed(1)} km · ${etaMinutes} min remaining`}
              time={formatNow()}
              timeAccent
              connectorBelow="amber-fade"
            />
            <Step
              state="pending"
              icon="home"
              title="Arrived & started"
              sub="Share OTP to begin"
              time={`~${addMinutes(etaMinutes)}`}
              connectorBelow="muted"
            />
            <Step
              state="pending"
              icon="check"
              title="Job completed"
              sub="Auto-rate & tip"
              time={`~${addMinutes(etaMinutes + 30)}`}
            />
          </View>

          {/* Booking ID footer */}
          <View style={{ alignItems: 'center', marginTop: 20 }}>
            <View style={styles.bkIdPill}>
              <Text style={[fontMono, styles.bkIdText]}>#{shortId}</Text>
            </View>
          </View>
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
});
