import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../../../theme';
import { showInfo } from '../../../utils/toast';
import type { LSThemeTokens } from '../utils/theme';
import type { SelectedPlace } from '../types';

const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#141414' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0A0A0A' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#cfcfcf' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1a2a1a' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1f1f1f' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#262626' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#6f6f6f' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#262626' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a2a05' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#5a3f08' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#F5A300' }] },
  { featureType: 'road.local', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1f2a' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#3a6a8a' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#181818' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#152015' }] },
];

const LIGHT_MAP_STYLE = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.local', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c4d9e8' }] },
];

interface Props {
  t: LSThemeTokens;
  isDark: boolean;
  place: SelectedPlace;
  isServiceable: boolean;
  onPlaceUpdate: (place: SelectedPlace) => void;
  onReverseGeocode: (lat: number, lon: number, cb: (name: string) => void) => void;
  onConfirm: () => void;
  onChange: () => void;
  onDismiss: () => void;
}

export function ConfirmPinStep({
  t,
  isDark,
  place,
  isServiceable,
  onPlaceUpdate,
  onReverseGeocode,
  onConfirm,
  onChange,
  onDismiss,
}: Props) {
  const mapRef = useRef<MapView>(null);
  const [displayName, setDisplayName] = useState(place.name);

  useEffect(() => {
    setDisplayName(place.name);
    mapRef.current?.animateCamera(
      { center: { latitude: place.lat, longitude: place.lon }, zoom: 18 },
      { duration: 600 },
    );
  }, [place.lat, place.lon, place.name]);

  const handleRegionChange = useCallback(
    (region: Region) => {
      onPlaceUpdate({ ...place, lat: region.latitude, lon: region.longitude });
      onReverseGeocode(region.latitude, region.longitude, (name) => {
        setDisplayName(name);
        onPlaceUpdate({ name, lat: region.latitude, lon: region.longitude });
      });
    },
    [place, onPlaceUpdate, onReverseGeocode],
  );

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          style={[s.iconBtn, { backgroundColor: t.glass, borderColor: t.glassBorderHi }]}
          onPress={onDismiss}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Feather name="x" size={14} color={t.text} />
        </TouchableOpacity>
        <Text style={[s.title, { color: t.text }]}>Search your location</Text>
      </View>
      <View style={[s.divider, { backgroundColor: t.divider }]} />

      {/* Map */}
      <View style={[s.mapWrap, { borderColor: t.glassBorderHi }]}>
        <MapView
          ref={mapRef}
          provider={PROVIDER_GOOGLE}
          style={s.map}
          customMapStyle={isDark ? DARK_MAP_STYLE : LIGHT_MAP_STYLE}
          initialCamera={{
            center: { latitude: place.lat, longitude: place.lon },
            zoom: 18,
            heading: 0,
            pitch: 0,
          }}
          onRegionChangeComplete={handleRegionChange}
        />
        {/* Fixed center dot — the map pans under it, so its center is the
            picked location. Plain circle (Google-style), no teardrop pin. */}
        <View style={s.pinContainer} pointerEvents="none">
          <View style={s.centerDot} />
        </View>
      </View>

      <Text style={[s.mapHint, { color: t.textMuted }]}>
        Move the map to fine-tune your exact location.
      </Text>

      <View style={s.detectedRow}>
        <View style={[s.detectedDot, { backgroundColor: t.amber }]} />
        <Text style={[s.detectedText, { color: t.text }]} numberOfLines={2}>
          {displayName}
        </Text>
      </View>

      {!isServiceable ? (
        <View style={[s.notServiceable, { backgroundColor: t.glass, borderColor: t.glassBorder }]}>
          <View style={[s.nsIcon, { backgroundColor: t.amberFill }]}>
            <Feather name="alert-circle" size={20} color={t.amber} />
          </View>
          <Text style={[s.nsTitle, { color: t.textSecondary }]}>
            We're not in your area yet
          </Text>
          <TouchableOpacity
            style={[s.nsBtn, { backgroundColor: t.glass, borderColor: t.glassBorder }]}
            activeOpacity={0.7}
            onPress={() => showInfo("We'll notify you when we launch in your area.")}
          >
            <Text style={[s.nsBtnText, { color: t.textMuted }]}>
              Notify me when you launch here
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={s.actions}>
          <TouchableOpacity
            style={[s.btn, s.btnSecondary, { backgroundColor: t.glass, borderColor: t.glassBorderHi }]}
            onPress={onChange}
            activeOpacity={0.7}
          >
            <Text style={[s.btnSecondaryText, { color: t.text }]}>Change</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, s.btnPrimary]}
            onPress={onConfirm}
            activeOpacity={0.85}
          >
            <Text style={s.btnPrimaryText}>Confirm location</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 18,
    paddingBottom: 12,
    gap: 10,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 99,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: 19,
    letterSpacing: -0.3,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 14,
  },

  mapWrap: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 0.5,
    height: 330,
  },
  map: { flex: 1 },
  pinContainer: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -11,
    marginTop: -11,
  },
  centerDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#F5A300',
    borderWidth: 3,
    borderColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },

  mapHint: {
    fontFamily: FontFamily.regular,
    fontSize: 13,
    marginTop: 14,
  },
  detectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 18,
  },
  detectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    shadowColor: '#F5A300',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  detectedText: {
    flex: 1,
    fontFamily: FontFamily.semibold,
    fontSize: 16,
    letterSpacing: -0.1,
  },

  notServiceable: {
    marginTop: 18,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
  },
  nsIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  nsTitle: {
    fontFamily: FontFamily.semibold,
    fontSize: 13,
    textAlign: 'center',
  },
  nsBtn: {
    height: 40,
    borderRadius: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginTop: 4,
  },
  nsBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: 12,
  },

  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  btn: {
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  btnSecondary: {
    minWidth: 104,
    borderWidth: 1,
  },
  btnSecondaryText: {
    fontFamily: FontFamily.bold,
    fontSize: 14,
    letterSpacing: 0.05,
  },
  btnPrimary: {
    flex: 1,
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOpacity: 0.32,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  btnPrimaryText: {
    fontFamily: FontFamily.bold,
    fontSize: 14,
    letterSpacing: 0.05,
    color: '#0D0D0F',
  },
});
