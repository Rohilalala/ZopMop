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
import type { LocationSubscription } from 'expo-location';
import { useNavigation, useRoute } from '@react-navigation/native';
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

type BookingStatus = 'accepted' | 'in_progress' | 'completed';

export default function ProActiveScreen({ route }: Props) {
  const { bookingId: bookingIdRaw, serviceName, customerAddress, customerLat, customerLng } = route.params;
  const bookingId = bookingIdRaw.trim();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();

  const mapRef = useRef<MapView>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const locationWatcherRef = useRef<LocationSubscription | null>(null);
  const trackingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // ── WebSocket location streaming ──────────────────────────────────────────
  function connectWs() {
    if (!token || token === '__guest__') return;
    try {
      const ws = new WebSocket(getLocationWsUrl(token));
      wsRef.current = ws;
      ws.onopen = () => {
        // Send first location immediately on connect
        sendCurrentLocation(ws);
      };
      ws.onerror = () => {
        // Silently ignore — REST heartbeat in ProDashboard keeps Redis alive
      };
      ws.onclose = () => {
        wsRef.current = null;
      };
    } catch {
      // WebSocket not supported; fallback to REST via location watcher only
    }
  }

  function sendCurrentLocation(ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return;
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
      .then(pos => {
        const { latitude, longitude } = pos.coords;
        setProLat(latitude);
        setProLng(longitude);
        ws.send(JSON.stringify({ lat: latitude, lng: longitude }));
      })
      .catch(() => {});
  }

  // ── Start GPS watcher (streams every ~10s) ────────────────────────────────
  async function startLocationWatch() {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;

    locationWatcherRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 10000,
        distanceInterval: 20,
      },
      pos => {
        const { latitude, longitude } = pos.coords;
        setProLat(latitude);
        setProLng(longitude);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ lat: latitude, lng: longitude }));
        }
      },
    );
  }

  // ── Fetch tracking (for route polyline + ETA, from pro's perspective) ─────
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
    connectWs();
    startLocationWatch();
    fetchTracking();
    // Refresh route every 30s (less frequent than customer — pro is moving)
    trackingPollRef.current = setInterval(fetchTracking, 30000);

    return () => {
      wsRef.current?.close();
      locationWatcherRef.current?.remove();
      if (trackingPollRef.current) clearInterval(trackingPollRef.current);
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

        {/* Route polyline */}
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

      {/* Status chip top */}
      <SafeAreaView style={s.topWrap} edges={['top']}>
        <View style={s.topChip}>
          <Text style={s.topChipText}>
            {bookingStatus === 'in_progress' ? '✅  Service in progress' : eta > 0 ? `🚶  ${eta} min to customer` : '📍  Navigate to customer'}
          </Text>
        </View>
      </SafeAreaView>

      {/* Bottom action bar */}
      <View style={s.bottomBar}>
        {/* Address */}
        <View style={s.addressRow}>
          <Text style={s.addressLabel}>Customer location</Text>
          <Text style={s.addressText} numberOfLines={2}>{customerAddress}</Text>
        </View>

        {/* Navigation button */}
        <TouchableOpacity style={s.navBtn} activeOpacity={0.85} onPress={openNavigation}>
          <Text style={s.navBtnText}>🗺️  Open Navigation</Text>
        </TouchableOpacity>

        {/* Primary action button */}
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
