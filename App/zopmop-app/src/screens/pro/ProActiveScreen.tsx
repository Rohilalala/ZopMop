import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  
  Linking,
  AppState,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import polyline from '@mapbox/polyline';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useProRoleGate } from '../../hooks/useRoleGate';
import {
  getBookingTracking,
  arrivedBooking,
  startBooking,
  completeBooking,
  getLocationWsUrl,
  type TrackingResponse,
} from '../../api/matching';
import { apiFetch } from '../../api/client';
import { BASE_URL } from '../../api/config';
import { haptics } from '../../utils/haptics';
import { showError, showInfo } from '../../utils/toast';
import OfflineBanner from '../../components/OfflineBanner';
import SvgIcon from '../../components/SvgIcon';
import { Feather } from '@expo/vector-icons';

const LOCATION_PUSH_MS = 10_000;
const TRACKING_POLL_MS = 30_000;
const STATUS_POLL_MS = 5_000;

const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#f9fafb' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6b7280' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e5e7eb' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#eef2ff' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#818cf8' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#ccfbf1' }] },
];

type Props = {
  route: RouteProp<MainStackParamList, 'ProActive'>;
};

type BookingStatus = 'accepted' | 'in_progress' | 'completed' | 'cancelled';

export default function ProActiveScreen({ route }: Props) {
  useProRoleGate();
  const { bookingId: bookingIdRaw, customerAddress, customerLat, customerLng } = route.params;
  const bookingId = bookingIdRaw.replace(/\s/g, '');
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const mapRef = useRef<MapView>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsClosedByUnmount = useRef(false);
  const mountedRef = useRef(true);
  // Interval that pushes raw GPS coords to Redis every 10 s (no Google Maps involved).
  const locationPushRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateSubRef = useRef<{ remove: () => void } | null>(null);
  const cancelledAlertShownRef = useRef(false);
  const fittedRef = useRef(false);

  const [proLat, setProLat] = useState<number>(0);
  const [proLng, setProLng] = useState<number>(0);
  const [tracking, setTracking] = useState<TrackingResponse | null>(null);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number; longitude: number }[]>([]);
  const [bookingStatus, setBookingStatus] = useState<BookingStatus>('accepted');
  // Tracks whether the pro has tapped "I've Arrived". Drives the secondary
  // "Start Service" CTA on this screen and the "Pro's at your door" state on
  // the customer's BookingConfirmed screen.
  const [hasArrived, setHasArrived] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  function decodePolyline(encoded: string) {
    if (!encoded) return [];
    try {
      return polyline.decode(encoded).map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
    } catch {
      return [];
    }
  }

  function fitMap(pLat: number, pLng: number, cLat: number, cLng: number) {
    if (!mapRef.current || !pLat || !pLng) return;
    mapRef.current.fitToCoordinates(
      [
        { latitude: pLat, longitude: pLng },
        { latitude: cLat, longitude: cLng },
      ],
      { edgePadding: { top: 80, right: 60, bottom: 300, left: 60 }, animated: true },
    );
  }

  // ── WebSocket (real-time path, best-effort) ───────────────────────────────
  // Reconnects with exponential backoff (1s → 30s cap) on close.
  // Reset attempt counter on successful open. Skip reconnect when unmounting.
  // Self-reference via ref so the reconnect timer can call the freshest
  // closure without breaking useCallback's dependency graph.
  const connectWsRef = useRef<() => void>(() => {});
  const connectWs = useCallback(() => {
    if (!token || token === '__guest__') return;
    try {
      // Security: token is NOT in the URL (would appear in server/proxy logs).
      // It is sent as the first message after the connection is established.
      const ws = new WebSocket(getLocationWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        reconnectAttempts.current = 0;
        ws.send(JSON.stringify({ type: 'auth', token }));
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'auth_error') {
            ws.close();
            showError('Live tracking disconnected. Continuing in fallback mode.');
          }
        } catch { /* non-JSON message, ignore */ }
      };
      ws.onerror = () => { /* silent — REST fallback handles it */ };
      ws.onclose = () => {
        wsRef.current = null;
        if (wsClosedByUnmount.current) return;
        const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts.current);
        reconnectAttempts.current += 1;
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null;
          if (!wsClosedByUnmount.current) connectWsRef.current();
        }, delay);
      };
    } catch { /* WS not available */ }
  }, [token]);
  useEffect(() => { connectWsRef.current = connectWs; }, [connectWs]);

  // ── Core location push — raw GPS → Redis, no Google Maps ─────────────────
  // Called on a hard 10-second interval so it's reliable on the simulator and
  // on real devices regardless of OS-level location batching.
  const pushCurrentLocation = useCallback(async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude } = pos.coords;
      setProLat(latitude);
      setProLng(longitude);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Fast path: WebSocket writes straight to Redis GEO in the location service.
        wsRef.current.send(JSON.stringify({ lat: latitude, lng: longitude }));
      } else {
        // Fallback: REST PUT /helpers/me/location also writes to Redis GEO + Postgres.
        apiFetch(`${BASE_URL}/helpers/me/location`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ lat: latitude, lng: longitude }),
        }).catch(() => {});
      }
    } catch (e) { if (__DEV__) console.warn('pushCurrentLocation:', e); }
  }, [token]);

  // ── Poll booking status — detect customer cancellation ───────────────────
  const fetchStatus = useCallback(async () => {
    if (!token || token === '__guest__') return;
    try {
      const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'cancelled' && !cancelledAlertShownRef.current) {
          cancelledAlertShownRef.current = true;
          if (statusPollRef.current) clearInterval(statusPollRef.current);
          showInfo('The customer has cancelled this booking.', { title: 'Booking Cancelled' });
          navigation.replace('ProDashboard');
        } else {
          setBookingStatus(data.status as BookingStatus);
        }
      }
    } catch { /* silently keep polling */ }
  }, [token, bookingId, navigation]);

  // ── Fetch tracking (route polyline + ETA from Google Maps, pro's view) ────
  const fetchTracking = useCallback(async () => {
    if (!token || token === '__guest__') return;
    try {
      const data = await getBookingTracking(token, bookingId);
      setTracking(data);
      const coords = decodePolyline(data.polyline);
      setRouteCoords(coords);
      setLoading(false);

      if (!fittedRef.current && data.helper_lat && data.helper_lng) {
        fittedRef.current = true;
        fitMap(data.helper_lat, data.helper_lng, customerLat, customerLng);
      }
    } catch {
      setLoading(false);
    }
  }, [token, bookingId, customerLat, customerLng]);

  useEffect(() => {
    wsClosedByUnmount.current = false;

    const startHeartbeat = () => {
      if (locationPushRef.current) return; // guard against stacking
      pushCurrentLocation();
      locationPushRef.current = setInterval(pushCurrentLocation, LOCATION_PUSH_MS);
    };
    const stopHeartbeat = () => {
      if (locationPushRef.current) {
        clearInterval(locationPushRef.current);
        locationPushRef.current = null;
      }
    };

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      connectWs();

      // Push location immediately, then every 10 s while foregrounded.
      if (AppState.currentState === 'active') startHeartbeat();
    })();

    // Pause all polls when backgrounded; resume on foreground.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        stopHeartbeat();
        if (trackingPollRef.current) { clearInterval(trackingPollRef.current); trackingPollRef.current = null; }
        if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null; }
      } else if (next === 'active') {
        startHeartbeat();
        if (!trackingPollRef.current) trackingPollRef.current = setInterval(fetchTracking, TRACKING_POLL_MS);
        if (!statusPollRef.current) statusPollRef.current = setInterval(fetchStatus, STATUS_POLL_MS);
      }
    });
    appStateSubRef.current = sub;

    fetchTracking();
    fetchStatus();
    trackingPollRef.current = setInterval(fetchTracking, TRACKING_POLL_MS);
    statusPollRef.current = setInterval(fetchStatus, STATUS_POLL_MS);

    return () => {
      mountedRef.current = false;
      wsClosedByUnmount.current = true;
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      wsRef.current?.close();
      stopHeartbeat();
      if (trackingPollRef.current) clearInterval(trackingPollRef.current);
      if (statusPollRef.current) clearInterval(statusPollRef.current);
      appStateSubRef.current?.remove();
      appStateSubRef.current = null;
    };
  }, [connectWs, fetchStatus, fetchTracking, pushCurrentLocation]);

  // ── Actions ───────────────────────────────────────────────────────────────
  // Pro tapped "I've Arrived". Stamps arrived_at on the booking but leaves
  // status as accepted — the customer's screen flips to "Pro's at your door"
  // while the actual service starts only when handleStart is tapped next.
  async function handleArrive() {
    if (!token) return;
    haptics.medium();
    setActionLoading(true);
    try {
      await arrivedBooking(token, bookingId);
      haptics.success();
      setHasArrived(true);
    } catch (err: any) {
      showError(err?.message ?? 'Could not mark arrival. Try again.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStart() {
    if (!token) return;
    haptics.medium();
    setActionLoading(true);
    try {
      await startBooking(token, bookingId);
      haptics.success();
      setBookingStatus('in_progress');
    } catch (err: any) {
      showError(err?.message ?? 'Could not start service. Try again.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleComplete() {
    if (!token) return;
    haptics.warning();
    Alert.alert('Complete Service?', 'This will mark the service as done and end the booking.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Complete',
        onPress: async () => {
          haptics.heavy();
          setActionLoading(true);
          try {
            await completeBooking(token, bookingId);
            haptics.success();
            navigation.replace('ProDashboard');
          } catch (err: any) {
            showError(err?.message ?? 'Could not complete booking. Try again.');
            setActionLoading(false);
          }
        },
      },
    ]);
  }

  function openNavigation() {
    const url = `https://maps.google.com/?saddr=&daddr=${customerLat},${customerLng}`;
    Linking.openURL(url).catch(() =>
      showError('Please install Google Maps.', { title: 'Could not open Maps' }),
    );
  }

  const currentProLat = proLat || tracking?.helper_lat || 0;
  const currentProLng = proLng || tracking?.helper_lng || 0;
  const eta = tracking?.eta_minutes ?? 0;

  const initialRegion: Region | undefined =
    currentProLat && currentProLng
      ? {
          latitude: (currentProLat + customerLat) / 2,
          longitude: (currentProLng + customerLng) / 2,
          latitudeDelta: 0.04,
          longitudeDelta: 0.04,
        }
      : customerLat
      ? { latitude: customerLat, longitude: customerLng, latitudeDelta: 0.01, longitudeDelta: 0.01 }
      : undefined;

  return (
    <View style={s.container}>
      <OfflineBanner />
      {/* Full-screen map */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        provider={PROVIDER_GOOGLE}
        customMapStyle={MAP_STYLE}
        initialRegion={initialRegion}
        showsUserLocation={false}
        showsMyLocationButton={false}
      >
        {/* Pro's own position */}
        {currentProLat !== 0 && currentProLng !== 0 && (
          <Marker
            coordinate={{ latitude: currentProLat, longitude: currentProLng }}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={s.proMarker}>
              <SvgIcon name="walker" size={22} color={c.primary} />
            </View>
          </Marker>
        )}

        {/* Customer destination */}
        {customerLat !== 0 && customerLng !== 0 && (
          <Marker
            coordinate={{ latitude: customerLat, longitude: customerLng }}
            anchor={{ x: 0.5, y: 1.0 }}
          >
            <View style={s.customerMarker}>
              <SvgIcon name="location-pin" size={22} color={c.danger} />
            </View>
          </Marker>
        )}

        {/* Route polyline (from Google Maps directions) */}
        {routeCoords.length > 1 && (
          <Polyline
            coordinates={routeCoords}
            strokeColor={c.primary}
            strokeWidth={4}
          />
        )}
      </MapView>

      {loading && (
        <View style={s.loadingOverlay}>
          <LoadingBars size="large" color={c.primary} />
        </View>
      )}

      {/* Status chip */}
      <SafeAreaView style={s.topWrap} edges={['top']}>
        <View style={s.topChip}>
          {bookingStatus === 'in_progress' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <SvgIcon name="check-circle" size={14} color={c.text} />
              <Text style={s.topChipText}>Service in progress</Text>
            </View>
          ) : eta > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <SvgIcon name="walker" size={14} color={c.text} />
              <Text style={s.topChipText}>{eta} min to customer</Text>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <SvgIcon name="location-pin" size={14} color={c.text} />
              <Text style={s.topChipText}>Navigate to customer</Text>
            </View>
          )}
        </View>
      </SafeAreaView>

      {/* Bottom action bar */}
      <View style={s.bottomBar}>
        <View style={s.addressRow}>
          <Text style={s.addressLabel}>Customer location</Text>
          <Text style={s.addressText} numberOfLines={2}>{customerAddress}</Text>
        </View>

        <TouchableOpacity style={s.navBtn} activeOpacity={0.85} onPress={openNavigation} accessibilityLabel="Open navigation" accessibilityRole="button">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <SvgIcon name="map-open" size={18} color={c.accent} />
            <Text style={s.navBtnText}>Open Navigation</Text>
          </View>
        </TouchableOpacity>

        {bookingStatus === 'accepted' && !hasArrived && (
          <TouchableOpacity
            style={[s.actionBtn, s.arriveBtn, actionLoading && s.btnDisabled]}
            activeOpacity={0.88}
            onPress={handleArrive}
            disabled={actionLoading}
            accessibilityLabel="I've arrived"
            accessibilityRole="button"
          >
            {actionLoading
              ? <LoadingBars color="#FFFFFF" />
              : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <SvgIcon name="check-circle" size={18} color="#FFFFFF" />
                  <Text style={s.actionBtnText}>I've Arrived</Text>
                </View>
              )
            }
          </TouchableOpacity>
        )}

        {bookingStatus === 'accepted' && hasArrived && (
          <TouchableOpacity
            style={[s.actionBtn, s.arriveBtn, actionLoading && s.btnDisabled]}
            activeOpacity={0.88}
            onPress={handleStart}
            disabled={actionLoading}
            accessibilityLabel="Start service"
            accessibilityRole="button"
          >
            {actionLoading
              ? <LoadingBars color="#FFFFFF" />
              : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Feather name="play" size={18} color="#FFFFFF" />
                  <Text style={s.actionBtnText}>Start Service</Text>
                </View>
              )
            }
          </TouchableOpacity>
        )}

        {bookingStatus === 'in_progress' && (
          <TouchableOpacity
            style={[s.actionBtn, s.completeBtn, actionLoading && s.btnDisabled]}
            activeOpacity={0.88}
            onPress={handleComplete}
            disabled={actionLoading}
            accessibilityLabel="Complete service"
            accessibilityRole="button"
          >
            {actionLoading
              ? <LoadingBars color="#FFFFFF" />
              : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <SvgIcon name="flag-finish" size={18} color="#FFFFFF" />
                  <Text style={s.actionBtnText}>Complete Service</Text>
                </View>
              )
            }
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },

    loadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(255,255,255,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
    },

    topWrap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      alignItems: 'center',
      paddingTop: 8,
    },
    topChip: {
      backgroundColor: c.white,
      borderRadius: Radius.full,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: c.border,
      ...Shadow.sm,
    },
    topChipText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.text,
    },

    proMarker: {
      backgroundColor: c.white,
      borderRadius: 20,
      padding: 6,
      borderWidth: 2,
      borderColor: c.primary,
      ...Shadow.sm,
    },
    customerMarker: {
      backgroundColor: c.white,
      borderRadius: 20,
      padding: 6,
      borderWidth: 2,
      borderColor: c.danger,
      ...Shadow.sm,
    },
    bottomBar: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: c.white,
      borderTopLeftRadius: Radius['2xl'],
      borderTopRightRadius: Radius['2xl'],
      padding: 24,
      paddingBottom: 40,
      gap: 12,
      ...Shadow.lg,
    },

    addressRow: { gap: 2 },
    addressLabel: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.xs,
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    addressText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.text,
      lineHeight: 22,
    },

    navBtn: {
      backgroundColor: c.surface,
      borderRadius: Radius.xl,
      paddingVertical: 14,
      alignItems: 'center',
      borderWidth: 1.5,
      borderColor: c.accent,
    },
    navBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.accent,
    },

    actionBtn: {
      borderRadius: Radius.xl,
      paddingVertical: 18,
      alignItems: 'center',
      ...Shadow.md,
    },
    arriveBtn: { backgroundColor: c.success },
    completeBtn: { backgroundColor: c.primary },
    btnDisabled: { opacity: 0.65 },
    actionBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: '#FFFFFF',
      letterSpacing: 0.2,
    },
  });
}
