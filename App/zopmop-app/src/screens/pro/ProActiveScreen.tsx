import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import polyline from '@mapbox/polyline';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import {
  getBookingTracking,
  startBooking,
  completeBooking,
  getLocationWsUrl,
  type TrackingResponse,
} from '../../api/matching';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';

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
  const { bookingId: bookingIdRaw, customerAddress, customerLat, customerLng } = route.params;
  const bookingId = bookingIdRaw.replace(/\s/g, '');
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();

  const mapRef = useRef<MapView>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Interval that pushes raw GPS coords to Redis every 10 s (no Google Maps involved).
  const locationPushRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledAlertShownRef = useRef(false);
  const fittedRef = useRef(false);

  const [proLat, setProLat] = useState<number>(0);
  const [proLng, setProLng] = useState<number>(0);
  const [tracking, setTracking] = useState<TrackingResponse | null>(null);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number; longitude: number }[]>([]);
  const [bookingStatus, setBookingStatus] = useState<BookingStatus>('accepted');
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
  function connectWs() {
    if (!token || token === '__guest__') return;
    try {
      const ws = new WebSocket(getLocationWsUrl(token));
      wsRef.current = ws;
      ws.onerror = () => { /* silent — REST fallback handles it */ };
      ws.onclose = () => { wsRef.current = null; };
    } catch { /* WS not available */ }
  }

  // ── Core location push — raw GPS → Redis, no Google Maps ─────────────────
  // Called on a hard 10-second interval so it's reliable on the simulator and
  // on real devices regardless of OS-level location batching.
  async function pushCurrentLocation() {
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
        fetch(`${BASE_URL}/helpers/me/location`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ lat: latitude, lng: longitude }),
        }).catch(() => {});
      }
    } catch { /* GPS unavailable — skip this tick */ }
  }

  // ── Poll booking status — detect customer cancellation ───────────────────
  const fetchStatus = useCallback(async () => {
    if (!token || token === '__guest__') return;
    try {
      const res = await fetch(`${BASE_URL}/bookings/${bookingId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'cancelled' && !cancelledAlertShownRef.current) {
          cancelledAlertShownRef.current = true;
          if (statusPollRef.current) clearInterval(statusPollRef.current);
          Alert.alert(
            'Booking Cancelled',
            'The customer has cancelled this booking.',
            [{ text: 'OK', onPress: () => navigation.replace('ProDashboard') }],
            { cancelable: false },
          );
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
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      connectWs();

      // Push location immediately, then every 10 s.
      pushCurrentLocation();
      locationPushRef.current = setInterval(pushCurrentLocation, 10000);
    })();

    fetchTracking();
    fetchStatus();
    // Refresh route polyline every 30 s (Google Maps call — kept as-is).
    trackingPollRef.current = setInterval(fetchTracking, 30000);
    // Poll booking status every 5 s to catch customer cancellations quickly.
    statusPollRef.current = setInterval(fetchStatus, 5000);

    return () => {
      wsRef.current?.close();
      if (locationPushRef.current) clearInterval(locationPushRef.current);
      if (trackingPollRef.current) clearInterval(trackingPollRef.current);
      if (statusPollRef.current) clearInterval(statusPollRef.current);
    };
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────
  async function handleArrive() {
    if (!token) return;
    setActionLoading(true);
    try {
      await startBooking(token, bookingId);
      setBookingStatus('in_progress');
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not mark arrival. Try again.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleComplete() {
    if (!token) return;
    Alert.alert('Complete Service?', 'This will mark the service as done and end the booking.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Complete',
        onPress: async () => {
          setActionLoading(true);
          try {
            await completeBooking(token, bookingId);
            navigation.replace('ProDashboard');
          } catch (err: any) {
            Alert.alert('Error', err?.message ?? 'Could not complete booking. Try again.');
            setActionLoading(false);
          }
        },
      },
    ]);
  }

  function openNavigation() {
    const url = `https://maps.google.com/?saddr=&daddr=${customerLat},${customerLng}`;
    Linking.openURL(url).catch(() =>
      Alert.alert('Could not open Maps', 'Please install Google Maps.'),
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
              <Text style={s.markerEmoji}>🚶</Text>
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
              <Text style={s.markerEmoji}>📍</Text>
            </View>
          </Marker>
        )}

        {/* Route polyline (from Google Maps directions) */}
        {routeCoords.length > 1 && (
          <Polyline
            coordinates={routeCoords}
            strokeColor={Colors.primary}
            strokeWidth={4}
          />
        )}
      </MapView>

      {loading && (
        <View style={s.loadingOverlay}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      )}

      {/* Status chip */}
      <SafeAreaView style={s.topWrap} edges={['top']}>
        <View style={s.topChip}>
          <Text style={s.topChipText}>
            {bookingStatus === 'in_progress' ? '✅  Service in progress' : eta > 0 ? `🚶  ${eta} min to customer` : '📍  Navigate to customer'}
          </Text>
        </View>
      </SafeAreaView>

      {/* Bottom action bar */}
      <View style={s.bottomBar}>
        <View style={s.addressRow}>
          <Text style={s.addressLabel}>Customer location</Text>
          <Text style={s.addressText} numberOfLines={2}>{customerAddress}</Text>
        </View>

        <TouchableOpacity style={s.navBtn} activeOpacity={0.85} onPress={openNavigation}>
          <Text style={s.navBtnText}>🗺️  Open Navigation</Text>
        </TouchableOpacity>

        {bookingStatus === 'accepted' && (
          <TouchableOpacity
            style={[s.actionBtn, s.arriveBtn, actionLoading && s.btnDisabled]}
            activeOpacity={0.88}
            onPress={handleArrive}
            disabled={actionLoading}
          >
            {actionLoading
              ? <ActivityIndicator color={Colors.white} />
              : <Text style={s.actionBtnText}>✅  I've Arrived</Text>
            }
          </TouchableOpacity>
        )}

        {bookingStatus === 'in_progress' && (
          <TouchableOpacity
            style={[s.actionBtn, s.completeBtn, actionLoading && s.btnDisabled]}
            activeOpacity={0.88}
            onPress={handleComplete}
            disabled={actionLoading}
          >
            {actionLoading
              ? <ActivityIndicator color={Colors.white} />
              : <Text style={s.actionBtnText}>🏁  Complete Service</Text>
            }
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

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
    backgroundColor: Colors.white,
    borderRadius: Radius.full,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  topChipText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.text,
  },

  proMarker: {
    backgroundColor: Colors.white,
    borderRadius: 20,
    padding: 6,
    borderWidth: 2,
    borderColor: Colors.primary,
    ...Shadow.sm,
  },
  customerMarker: {
    backgroundColor: Colors.white,
    borderRadius: 20,
    padding: 6,
    borderWidth: 2,
    borderColor: Colors.danger,
    ...Shadow.sm,
  },
  markerEmoji: { fontSize: 22 },

  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.white,
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
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  addressText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.text,
    lineHeight: 22,
  },

  navBtn: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.accent,
  },
  navBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.accent,
  },

  actionBtn: {
    borderRadius: Radius.xl,
    paddingVertical: 18,
    alignItems: 'center',
    ...Shadow.md,
  },
  arriveBtn: { backgroundColor: Colors.success },
  completeBtn: { backgroundColor: Colors.primary },
  btnDisabled: { opacity: 0.65 },
  actionBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.white,
    letterSpacing: 0.2,
  },
});
