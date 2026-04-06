import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import polyline from '@mapbox/polyline';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { getBookingTracking, type TrackingResponse } from '../../api/matching';
import { apiFetch } from '../../api/client';

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
  route: RouteProp<MainStackParamList, 'ActiveBooking'>;
};

type BookingStatus = 'accepted' | 'in_progress' | 'completed' | 'cancelled';

export default function ActiveBookingScreen({ route }: Props) {
  const { bookingId, serviceName, helperName, helperRating, helperLat: initialHelperLat, helperLng: initialHelperLng } =
    route.params;
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();

  const mapRef = useRef<MapView>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const animTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fittedRef = useRef(false);
  const helperMarkerPos = useRef({ lat: initialHelperLat ?? 0, lng: initialHelperLng ?? 0 });

  const [tracking, setTracking] = useState<TrackingResponse | null>(null);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number; longitude: number }[]>([]);
  const [bookingStatus, setBookingStatus] = useState<BookingStatus>('accepted');
  const [loading, setLoading] = useState(true);
  const [markerCoord, setMarkerCoord] = useState({
    latitude: initialHelperLat ?? 0,
    longitude: initialHelperLng ?? 0,
  });

  // Decode polyline string → coordinate array
  function decodePolyline(encoded: string) {
    if (!encoded) return [];
    try {
      return polyline.decode(encoded).map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
    } catch {
      return [];
    }
  }

  // Fit map to show both markers
  function fitMap(helperLat: number, helperLng: number, custLat: number, custLng: number) {
    if (!mapRef.current) return;
    mapRef.current.fitToCoordinates(
      [
        { latitude: helperLat, longitude: helperLng },
        { latitude: custLat, longitude: custLng },
      ],
      { edgePadding: { top: 80, right: 60, bottom: 320, left: 60 }, animated: true },
    );
  }

  function startSmoothMove(fromLat: number, fromLng: number, toLat: number, toLng: number) {
    if (animTickRef.current) clearInterval(animTickRef.current);
    const duration = 10000; // 10 s to match push cadence
    const startTime = Date.now();
    animTickRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      setMarkerCoord({
        latitude: fromLat + (toLat - fromLat) * t,
        longitude: fromLng + (toLng - fromLng) * t,
      });
      if (t >= 1) {
        clearInterval(animTickRef.current!);
        animTickRef.current = null;
      }
    }, 100);
  }

  const fetchTracking = useCallback(async () => {
    if (!token || token === '__guest__') return;
    try {
      const data = await getBookingTracking(token, bookingId);
      setTracking(data);
      const coords = decodePolyline(data.polyline);
      setRouteCoords(coords);
      setLoading(false);

      if (data.helper_lat && data.helper_lng) {
        const prev = helperMarkerPos.current;
        const newLat = data.helper_lat;
        const newLng = data.helper_lng;
        const moved = Math.abs(newLat - prev.lat) > 0.000001 || Math.abs(newLng - prev.lng) > 0.000001;
        if (moved) {
          startSmoothMove(prev.lat || newLat, prev.lng || newLng, newLat, newLng);
          helperMarkerPos.current = { lat: newLat, lng: newLng };
        }
        if (!fittedRef.current) {
          fittedRef.current = true;
          fitMap(newLat, newLng, data.customer_lat, data.customer_lng);
        }
      }
    } catch {
      setLoading(false);
      // Tracking may not yet be available (booking just accepted) — keep polling
    }
  }, [token, bookingId]);

  // Poll booking status to detect in_progress / completed
  const fetchStatus = useCallback(async () => {
    if (!token || token === '__guest__') return;
    try {
      const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setBookingStatus(data.status as BookingStatus);
        if (data.status === 'completed' || data.status === 'cancelled') {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }
    } catch { /* silently keep polling */ }
  }, [token, bookingId]);

  useEffect(() => {
    fetchTracking();
    fetchStatus();
    pollRef.current = setInterval(() => {
      fetchTracking();
      fetchStatus();
    }, 10000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (animTickRef.current) clearInterval(animTickRef.current);
    };
  }, [fetchTracking, fetchStatus]);

  function handleCancel() {
    Alert.alert(
      'Cancel Booking?',
      'Are you sure you want to cancel? Cancellation fees may apply.',
      [
        { text: 'Keep Booking', style: 'cancel' },
        {
          text: 'Cancel Booking',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiFetch(`${BASE_URL}/bookings/${bookingId}/cancel`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
              });
            } catch { /* best effort */ }
            navigation.goBack();
          },
        },
      ],
    );
  }

  const helperLat = tracking?.helper_lat ?? initialHelperLat ?? 0;
  const helperLng = tracking?.helper_lng ?? initialHelperLng ?? 0;
  const custLat = tracking?.customer_lat ?? 0;
  const custLng = tracking?.customer_lng ?? 0;
  const eta = tracking?.eta_minutes ?? 0;
  const arrived = bookingStatus === 'in_progress' || bookingStatus === 'completed';

  // Center the map: prefer midpoint between helper and customer, then either
  // individually, then fall back to Gurugram HQ so the map is never blank.
  const centerLat = helperLat && custLat ? (helperLat + custLat) / 2
    : helperLat || custLat || 28.4357;
  const centerLng = helperLng && custLng ? (helperLng + custLng) / 2
    : helperLng || custLng || 77.0763;

  const initialRegion: Region = {
    latitude: centerLat,
    longitude: centerLng,
    latitudeDelta: 0.04,
    longitudeDelta: 0.04,
  };

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
        {/* Helper marker */}
        {markerCoord.latitude !== 0 && markerCoord.longitude !== 0 && (
          <Marker coordinate={markerCoord} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={s.helperMarker}>
              <Text style={s.markerEmoji}>🚶</Text>
            </View>
          </Marker>
        )}

        {/* Customer (destination) marker */}
        {custLat !== 0 && custLng !== 0 && (
          <Marker coordinate={{ latitude: custLat, longitude: custLng }} anchor={{ x: 0.5, y: 1.0 }}>
            <View style={s.customerMarker}>
              <Text style={s.markerEmoji}>🏠</Text>
            </View>
          </Marker>
        )}

        {/* Route polyline */}
        {routeCoords.length > 1 && (
          <Polyline
            coordinates={routeCoords}
            strokeColor={Colors.primary}
            strokeWidth={4}
            lineDashPattern={undefined}
          />
        )}
      </MapView>

      {/* Loading overlay */}
      {loading && (
        <View style={s.loadingOverlay}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      )}

      {/* Status badge top-left */}
      <SafeAreaView style={s.topBadgeWrap} edges={['top']}>
        <View style={[s.statusBadge, arrived ? s.badgeArrived : s.badgeActive]}>
          <View style={[s.statusDot, { backgroundColor: arrived ? Colors.success : Colors.primary }]} />
          <Text style={[s.statusText, { color: arrived ? Colors.success : Colors.primary }]}>
            {bookingStatus === 'completed' ? 'Service Complete' : arrived ? 'Pro has arrived!' : 'Pro on the way'}
          </Text>
        </View>
      </SafeAreaView>

      {/* Bottom sheet */}
      <View style={s.sheet}>
        {/* ETA row */}
        <View style={s.etaRow}>
          <View>
            <Text style={s.etaLabel}>
              {arrived ? 'Pro is at your location' : eta > 0 ? `🚶 ${eta} min away` : 'Locating your pro…'}
            </Text>
            <Text style={s.bookingRef}>Booking #{bookingId.slice(0, 8).toUpperCase()}</Text>
          </View>
          <View style={s.etaBadge}>
            <Text style={s.etaBadgeText}>{serviceName}</Text>
          </View>
        </View>

        {/* Pro card */}
        <View style={s.proRow}>
          <View style={s.proAvatar}>
            <Text style={s.proAvatarText}>{helperName?.charAt(0).toUpperCase() ?? '?'}</Text>
          </View>
          <View style={s.proInfo}>
            <Text style={s.proName}>{helperName}</Text>
            <Text style={s.proRating}>⭐ {helperRating?.toFixed(1)}</Text>
          </View>
        </View>

        {/* Status steps */}
        <View style={s.stepsRow}>
          <Step done label="Confirmed" />
          <View style={[s.stepLine, (!arrived) && s.stepLineActive]} />
          <Step done={arrived} active={!arrived} label="On the way" />
          <View style={[s.stepLine, arrived && s.stepLineActive]} />
          <Step done={bookingStatus === 'completed'} active={arrived && bookingStatus !== 'completed'} label="Arrived" />
          <View style={s.stepLine} />
          <Step done={bookingStatus === 'completed'} label="Done" />
        </View>

        {/* Cancel button — only while still accepted */}
        {bookingStatus === 'accepted' && (
          <TouchableOpacity style={s.cancelBtn} activeOpacity={0.75} onPress={handleCancel}>
            <Text style={s.cancelBtnText}>Cancel Booking</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function Step({ label, done, active }: { label: string; done?: boolean; active?: boolean }) {
  return (
    <View style={s.stepItem}>
      <View style={[s.stepDot, done && s.stepDotDone, active && !done && s.stepDotActive]} />
      <Text style={[s.stepLabel, (done || active) && s.stepLabelActive]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  topBadgeWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.full,
    borderWidth: 1,
    ...Shadow.sm,
  },
  badgeActive: { borderColor: `${Colors.primary}44`, backgroundColor: Colors.white },
  badgeArrived: { borderColor: `${Colors.success}44`, backgroundColor: Colors.white },
  statusDot: { width: 8, height: 8, borderRadius: Radius.full },
  statusText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm },

  // Markers
  helperMarker: {
    backgroundColor: Colors.white,
    borderRadius: 20,
    padding: 6,
    borderWidth: 2,
    borderColor: Colors.accent,
    ...Shadow.sm,
  },
  customerMarker: {
    backgroundColor: Colors.white,
    borderRadius: 20,
    padding: 6,
    borderWidth: 2,
    borderColor: Colors.primary,
    ...Shadow.sm,
  },
  markerEmoji: { fontSize: 22 },

  // Bottom sheet
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.white,
    borderTopLeftRadius: Radius['2xl'],
    borderTopRightRadius: Radius['2xl'],
    padding: 24,
    paddingBottom: 36,
    gap: 16,
    ...Shadow.lg,
  },

  etaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  etaLabel: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    marginBottom: 2,
  },
  bookingRef: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  etaBadge: {
    backgroundColor: Colors.primaryBg,
    borderRadius: Radius.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: `${Colors.primary}33`,
  },
  etaBadgeText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  proRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  proAvatar: {
    width: 48,
    height: 48,
    borderRadius: Radius.full,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: `${Colors.primary}22`,
  },
  proAvatarText: { fontFamily: FontFamily.extrabold, fontSize: FontSize.lg, color: Colors.primary },
  proInfo: { flex: 1 },
  proName: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: Colors.text, marginBottom: 2 },
  proRating: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary },

  stepsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepItem: { alignItems: 'center', gap: 4, flex: 0 },
  stepDot: {
    width: 12,
    height: 12,
    borderRadius: Radius.full,
    backgroundColor: Colors.border,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  stepDotDone: { backgroundColor: Colors.success, borderColor: Colors.success },
  stepDotActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  stepLabel: {
    fontFamily: FontFamily.regular,
    fontSize: 10,
    color: Colors.textMuted,
  },
  stepLabelActive: { color: Colors.text, fontFamily: FontFamily.semibold },
  stepLine: { flex: 1, height: 2, backgroundColor: Colors.border, marginBottom: 14 },
  stepLineActive: { backgroundColor: Colors.primary },

  cancelBtn: {
    alignSelf: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  cancelBtnText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
});
