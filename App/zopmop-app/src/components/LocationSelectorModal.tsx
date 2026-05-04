import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableWithoutFeedback,
  TouchableOpacity,
  TextInput,
  ScrollView,
  
  Animated,
  PanResponder,
  Dimensions,
  Platform,
  Keyboard,
  Alert,
  type TextStyle,
} from 'react-native';
import { LoadingBars } from './ui/LoadingBars';
import * as Location from 'expo-location';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import { Feather } from '@expo/vector-icons';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient as SvgRadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { useAuth } from '../context/AuthContext';
import { listAddresses, createAddress, deleteAddress, type ApiAddress } from '../api/addresses';
import { searchPlaces, type PlaceResult } from '../api/places';
import EditAddressModal from './EditAddressModal';
import { showError } from '../utils/toast';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const PANEL_WIDTH = SCREEN_WIDTH * 0.92;
const PANEL_HEIGHT = SCREEN_HEIGHT * 0.82;
const PANEL_BOTTOM = Platform.OS === 'ios' ? 36 : 16;

const fontReg:   TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const C = {
  bg: '#0A0A0A',
  amber: '#F5A300',
  amberHi: '#FFC042',
  text: '#FFFFFF',
  sub: 'rgba(255,255,255,0.62)',
  muted: 'rgba(255,255,255,0.45)',
  faint: 'rgba(255,255,255,0.28)',
  glassFill: 'rgba(255,255,255,0.05)',
  glassFillStrong: 'rgba(255,255,255,0.08)',
  glassBorder: 'rgba(255,255,255,0.08)',
  glassBorderStrong: 'rgba(255,255,255,0.14)',
  divider: 'rgba(255,255,255,0.06)',
  amberFill: 'rgba(245,163,0,0.14)',
  amberBorder: 'rgba(245,163,0,0.32)',
  danger: '#EF4444',
};

const DEFAULT_REGION: Region = {
  latitude: 28.4595,
  longitude: 77.0266,
  latitudeDelta: 0.001,
  longitudeDelta: 0.001,
};

// Dark map style matching the home aesthetic.
const MAP_STYLE = [
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

type Step = 'search' | 'details';
type SearchState = 'idle' | 'loading' | 'results' | 'no_results' | 'error';
type GpsState = 'idle' | 'loading' | 'denied';
export type AddressTag = 'Home' | 'Work' | 'Other';

export interface SavedAddress {
  id: string;
  tag: AddressTag;
  title: string;
  subtitle: string;
  lat: number;
  lon: number;
}

type GeocodedResult = PlaceResult;

interface SelectedPlace {
  name: string;
  lat: number;
  lon: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onLocationSelect: (name: string, lat: number, lon: number, addressId?: string) => void;
}

const TAG_ICONS: Record<AddressTag, keyof typeof Feather.glyphMap> = {
  Home: 'home',
  Work: 'briefcase',
  Other: 'map-pin',
};

export default function LocationSelectorModal({ visible, onClose, onLocationSelect }: Props) {
  const { token } = useAuth();

  // ── Modal state ──────────────────────────────────────────────────────────────
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>('search');
  const [savedAddresses, setSavedAddresses] = useState<ApiAddress[]>([]);

  // ── Step 1: search state ─────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [results, setResults] = useState<GeocodedResult[]>([]);
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null);
  const [editTarget, setEditTarget] = useState<ApiAddress | null>(null);
  const [userCoords, setUserCoords] = useState<{ lat: number; lon: number } | null>(null);
  // react-native-maps: SVG markers only render if tracksViewChanges is true
  // long enough to capture. Flip to false after mount to avoid per-frame redraw.
  const [trackZop, setTrackZop] = useState(true);

  useEffect(() => {
    if (!userCoords) return;
    setTrackZop(true);
    const t = setTimeout(() => setTrackZop(false), 800);
    return () => clearTimeout(t);
  }, [userCoords]);

  // ── Step 2: address form state ───────────────────────────────────────────────
  const [addressTag, setAddressTag] = useState<AddressTag>('Home');
  const [flatNo, setFlatNo] = useState('');
  const [floor, setFloor] = useState('');
  const [buildingName, setBuildingName] = useState('');
  const [landmark, setLandmark] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [receiverName, setReceiverName] = useState('');

  const slideAnim = useRef(new Animated.Value(PANEL_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapRef = useRef<MapView>(null);
  const searchInputRef = useRef<TextInput>(null);

  // ── Animation ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (visible) {
      setIsOpen(true);
      slideAnim.setValue(PANEL_HEIGHT);
      fadeAnim.setValue(0);
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: 0, duration: 320, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
      // Fetch saved addresses from backend when modal opens.
      if (token && token !== '__guest__') {
        listAddresses(token)
          .then(setSavedAddresses)
          .catch(() => { /* backend unavailable — keep empty list */ });
      }
      // Center map on user's current GPS without selecting it.
      centerMapOnCurrent();
    }
  }, [visible]);

  async function centerMapOnCurrent() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setUserCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      panMapTo(pos.coords.latitude, pos.coords.longitude);
    } catch { /* permission denied or GPS unavailable — keep default region */ }
  }

  function resetFormState() {
    setStep('search');
    setSearchQuery('');
    setSearchState('idle');
    setResults([]);
    setGpsState('idle');
    setSelectedPlace(null);
    setAddressTag('Home');
    setFlatNo('');
    setFloor('');
    setBuildingName('');
    setLandmark('');
    setReceiverPhone('');
    setReceiverName('');
  }

  function dismissModal() {
    Keyboard.dismiss();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: PANEL_HEIGHT, duration: 280, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      setIsOpen(false);
      resetFormState();
      onClose();
    });
  }

  function panMapTo(lat: number, lon: number) {
    mapRef.current?.animateCamera({ center: { latitude: lat, longitude: lon }, zoom: 16 }, { duration: 600 });
  }

  function handleMapRegionChangeComplete(region: Region) {
    setSelectedPlace((prev) => prev ? { ...prev, lat: region.latitude, lon: region.longitude } : prev);
  }

  // ── Swipe-down gesture ───────────────────────────────────────────────────────

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, { dy }) => dy > 4,
      onPanResponderMove: (_, { dy }) => { if (dy > 0) slideAnim.setValue(dy); },
      onPanResponderRelease: (_, { dy, vy }) => {
        if (dy > PANEL_HEIGHT * 0.22 || vy > 1.0) {
          dismissModal();
        } else {
          Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        }
      },
    })
  ).current;

  // ── Search ───────────────────────────────────────────────────────────────────

  function handleSearchChange(text: string) {
    setSearchQuery(text);
    if (selectedPlace) setSelectedPlace(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text.trim()) { setSearchState('idle'); setResults([]); return; }
    setSearchState('loading');
    debounceRef.current = setTimeout(() => fetchSearch(text.trim()), 400);
  }

  async function fetchSearch(query: string) {
    if (!token) { setSearchState('error'); return; }
    try {
      const items = await searchPlaces(token, query);
      if (items.length === 0) { setSearchState('no_results'); setResults([]); return; }
      setSearchState('results');
      setResults(items);
    } catch { setSearchState('error'); }
  }

  async function handleResultSelect(result: GeocodedResult) {
    setSelectedPlace({ name: result.description || result.main_text, lat: result.lat, lon: result.lon });
    setSearchQuery(result.description || result.main_text);
    setSearchState('idle');
    setResults([]);
    Keyboard.dismiss();
    panMapTo(result.lat, result.lon);
  }

  async function handleGps() {
    setGpsState('loading');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setGpsState('denied'); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;
      setUserCoords({ lat: latitude, lon: longitude });
      // expo-location's on-device reverse geocoder — no API key required.
      const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
      const address = place
        ? [place.name, place.district ?? place.subregion ?? place.city].filter(Boolean).join(', ')
        : 'Current Location';
      setSelectedPlace({ name: address || 'Current Location', lat: latitude, lon: longitude });
      setGpsState('idle');
      Keyboard.dismiss();
      panMapTo(latitude, longitude);
    } catch { setGpsState('denied'); }
  }

  function handleSavedSelect(addr: ApiAddress) {
    onLocationSelect(addr.full_address, addr.lat, addr.lon, addr.id);
    dismissModal();
  }

  function handleSavedDeleted(id: string) {
    setSavedAddresses(prev => prev.filter(a => a.id !== id));
  }

  // Proceed from map → address details form
  function confirmLocation() {
    if (!selectedPlace) return;
    Keyboard.dismiss();
    setStep('details');
  }

  // Final save — build full address, persist to backend, then close
  async function saveAddress() {
    if (!selectedPlace || !flatNo.trim() || !buildingName.trim()) return;
    const parts = [flatNo.trim(), floor.trim(), buildingName.trim(), landmark.trim(), selectedPlace.name]
      .filter(Boolean);
    const fullAddress = parts.join(', ');
    if (token && token !== '__guest__') {
      try {
        const saved = await createAddress(token, {
          tag: addressTag,
          title: addressTag === 'Other' ? buildingName.trim() : addressTag,
          flat_no: flatNo.trim(),
          floor: floor.trim(),
          building_name: buildingName.trim(),
          landmark: landmark.trim(),
          full_address: fullAddress,
          receiver_name: receiverName.trim(),
          receiver_phone: receiverPhone.trim(),
          lat: selectedPlace.lat,
          lon: selectedPlace.lon,
        });
        setSavedAddresses(prev => [saved, ...prev]);
      } catch {
        // Backend unavailable — address is used for this session only.
      }
    }
    onLocationSelect(fullAddress, selectedPlace.lat, selectedPlace.lon);
    dismissModal();
  }

  const canSave = flatNo.trim().length > 0 && buildingName.trim().length > 0;
  const showIdle = searchState === 'idle' && !selectedPlace;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
    <Modal transparent visible={isOpen} onRequestClose={dismissModal} statusBarTranslucent animationType="none">
      <TouchableWithoutFeedback onPress={step === 'search' ? dismissModal : undefined}>
        <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: fadeAnim }]} />
      </TouchableWithoutFeedback>

      <View style={s.panelContainer} pointerEvents="box-none">
        <Animated.View style={[s.panel, { transform: [{ translateY: slideAnim }] }]}>

          {/* Glass background layer — vertical fill + diagonal sheen + amber
              top-right bloom. Matches the home GlassCard hero recipe so the
              location surface reads as part of the same design language. */}
          <Svg
            width="100%"
            height="100%"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          >
            <Defs>
              <SvgLinearGradient id="locGlassFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%"   stopColor="#1C1C22" stopOpacity="0.96" />
                <Stop offset="100%" stopColor="#101015" stopOpacity="0.96" />
              </SvgLinearGradient>
              <SvgLinearGradient id="locGlassSheen" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0%"   stopColor="#FFFFFF" stopOpacity="0.10" />
                <Stop offset="35%"  stopColor="#FFFFFF" stopOpacity="0.02" />
                <Stop offset="60%"  stopColor="#FFFFFF" stopOpacity="0" />
              </SvgLinearGradient>
              <SvgRadialGradient
                id="locGlassBloom"
                cx="80" cy="0" rx="60" ry="60"
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset="0%"   stopColor="#F5A300" stopOpacity="0.10" />
                <Stop offset="100%" stopColor="#F5A300" stopOpacity="0" />
              </SvgRadialGradient>
            </Defs>
            <Rect width="100" height="100" fill="url(#locGlassFill)" />
            <Rect width="100" height="100" fill="url(#locGlassSheen)" />
            <Rect width="100" height="100" fill="url(#locGlassBloom)" />
          </Svg>

          {/* ── Drag handle (search step only) ── */}
          {step === 'search' && (
            <View {...panResponder.panHandlers} style={s.dragArea}>
              <View style={s.dragHandle} />
            </View>
          )}

          {/* ════════════════════════════════════════════════════
              STEP 1 — Location search
          ════════════════════════════════════════════════════ */}
          {step === 'search' && (
            <>
              {/* Header */}
              <View style={s.header}>
                <TouchableOpacity style={s.iconBtn} onPress={dismissModal} activeOpacity={0.7} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Feather name="x" size={16} color={C.text} />
                </TouchableOpacity>
                <Text style={s.headerTitle}>Search your location</Text>
              </View>

              <View style={s.headerDivider} />

              {/* Search bar */}
              <View style={s.searchWrap}>
                <View style={[s.searchBar, selectedPlace ? s.searchBarConfirmed : null]}>
                  {searchState === 'loading'
                    ? <LoadingBars size="small" color={C.amber} style={{ width: 18 }} />
                    : <Feather name="search" size={16} color={selectedPlace ? C.amber : C.muted} />
                  }
                  <TextInput
                    ref={searchInputRef}
                    style={s.searchInput}
                    placeholder="Search locality, sector, area"
                    placeholderTextColor={C.muted}
                    value={searchQuery}
                    onChangeText={handleSearchChange}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                    keyboardAppearance="dark"
                  />
                  {searchQuery.length > 0 && (
                    <TouchableOpacity style={s.clearBtn} onPress={() => handleSearchChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Feather name="x" size={11} color={C.text} />
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* Map */}
              <View style={s.mapWrap}>
                <MapView
                  ref={mapRef}
                  provider={PROVIDER_GOOGLE}
                  style={s.map}
                  customMapStyle={MAP_STYLE}
                  initialCamera={{
                    center: { latitude: DEFAULT_REGION.latitude, longitude: DEFAULT_REGION.longitude },
                    zoom: 15,
                    heading: 0,
                    pitch: 0,
                  }}
                  onRegionChangeComplete={handleMapRegionChangeComplete}
                >
                  {userCoords && (
                    <Marker
                      coordinate={{ latitude: userCoords.lat, longitude: userCoords.lon }}
                      anchor={{ x: 0.5, y: 0.5 }}
                      tracksViewChanges={trackZop}
                    >
                      <View style={s.zopMarker} collapsable={false} />
                    </Marker>
                  )}
                </MapView>
                {selectedPlace && (
                  <View style={s.centerPinContainer} pointerEvents="none">
                    <View style={s.centerPinHead} />
                    <View style={s.centerPinTail} />
                  </View>
                )}
              </View>

              {/* Selected place confirm strip */}
              {selectedPlace && (
                <View style={s.confirmWrap}>
                  <Text style={s.mapHint}>Drag the pin to fine-tune your exact location.</Text>
                  <View style={s.confirmAddressRow}>
                    <View style={s.pinDot} />
                    <Text style={s.confirmAddressText} numberOfLines={2}>{selectedPlace.name}</Text>
                  </View>
                  <View style={s.confirmActions}>
                    <TouchableOpacity style={s.changeBtn} onPress={() => { setSelectedPlace(null); setSearchQuery(''); }} activeOpacity={0.7}>
                      <Text style={s.changeBtnText}>Change</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.confirmBtn} onPress={confirmLocation} activeOpacity={0.85}>
                      <Text style={s.confirmBtnText}>Confirm Location</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* GPS + Add address */}
              {showIdle && (
                <View style={s.primaryActions}>
                  <TouchableOpacity style={s.actionRow} onPress={handleGps} disabled={gpsState === 'loading'} activeOpacity={0.7}>
                    <View style={[s.actionIconBox, { backgroundColor: C.amberFill, borderColor: C.amberBorder }]}>
                      {gpsState === 'loading'
                        ? <LoadingBars size="small" color={C.amber} />
                        : <Feather name="navigation" size={16} color={C.amber} />
                      }
                    </View>
                    <View style={s.actionTextCol}>
                      <Text style={s.actionTitle}>{gpsState === 'loading' ? 'Detecting location…' : 'Use current location'}</Text>
                      {gpsState === 'denied' && <Text style={s.actionError}>Permission denied — tap to retry</Text>}
                    </View>
                    <Feather name="chevron-right" size={14} color={C.faint} />
                  </TouchableOpacity>
                  <View style={s.actionDivider} />
                  <TouchableOpacity
                    style={s.actionRow}
                    onPress={() => searchInputRef.current?.focus()}
                    activeOpacity={0.7}
                  >
                    <View style={[s.actionIconBox, { backgroundColor: C.glassFillStrong, borderColor: C.glassBorderStrong }]}>
                      <Feather name="plus" size={16} color={C.text} />
                    </View>
                    <View style={s.actionTextCol}>
                      <Text style={s.actionTitle}>Add new address</Text>
                      <Text style={s.actionSub}>Search your area in the bar above</Text>
                    </View>
                    <Feather name="chevron-right" size={14} color={C.faint} />
                  </TouchableOpacity>
                </View>
              )}

              {/* Results / saved addresses */}
              {!selectedPlace && (
                <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                  {searchState === 'results' && results.map((result, idx) => (
                    <React.Fragment key={`${result.lat}-${result.lon}`}>
                      <TouchableOpacity style={s.resultRow} onPress={() => handleResultSelect(result)} activeOpacity={0.7}>
                        <View style={s.resultIconBox}>
                          <Feather name="map-pin" size={16} color={C.amber} />
                        </View>
                        <View style={s.resultTextCol}>
                          <Text style={s.resultPrimary} numberOfLines={1}>{result.main_text}</Text>
                          {result.secondary_text ? (
                            <Text style={s.resultSecondary} numberOfLines={1}>{result.secondary_text}</Text>
                          ) : null}
                        </View>
                      </TouchableOpacity>
                      {idx < results.length - 1 && <View style={s.rowDivider} />}
                    </React.Fragment>
                  ))}

                  {searchState === 'no_results' && (
                    <View style={s.emptyState}>
                      <View style={s.emptyIconWrap}>
                        <Feather name="map" size={22} color={C.amber} />
                      </View>
                      <Text style={s.emptyTitle}>No results found</Text>
                      <Text style={s.emptySubtitle}>Try a different area or locality</Text>
                    </View>
                  )}

                  {searchState === 'error' && (
                    <View style={s.emptyState}>
                      <View style={s.emptyIconWrap}>
                        <Feather name="alert-triangle" size={22} color={C.amber} />
                      </View>
                      <Text style={s.emptyTitle}>Couldn't fetch results</Text>
                      <TouchableOpacity onPress={() => fetchSearch(searchQuery)} activeOpacity={0.7}>
                        <Text style={s.retryText}>Tap to retry</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {showIdle && savedAddresses.length > 0 && (
                    <>
                      <Text style={s.sectionLabel}>SAVED ADDRESSES  ·  swipe left to edit, right to delete</Text>
                      {savedAddresses.map(addr => (
                        <SwipeSavedRow
                          key={addr.id}
                          addr={addr}
                          token={token}
                          onSelect={() => handleSavedSelect(addr)}
                          onEdit={() => setEditTarget(addr)}
                          onDeleted={handleSavedDeleted}
                        />
                      ))}
                    </>
                  )}
                </ScrollView>
              )}
            </>
          )}

          {/* ════════════════════════════════════════════════════
              STEP 2 — Address details form
          ════════════════════════════════════════════════════ */}
          {step === 'details' && (
            <View style={s.detailsRoot}>
              {/* Header */}
              <View style={s.detailsHeader}>
                <TouchableOpacity style={s.iconBtn} onPress={() => setStep('search')} activeOpacity={0.7} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Feather name="chevron-left" size={18} color={C.text} />
                </TouchableOpacity>
                <Text style={s.detailsHeaderTitle}>Add address details</Text>
              </View>

              <View style={s.headerDivider} />

              <ScrollView style={s.detailsScroll} contentContainerStyle={s.detailsScrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

                {/* ── Address details card ── */}
                <View style={s.formCard}>
                  <Text style={s.formCardTitle}>Address details</Text>

                  {/* Save as tag */}
                  <Text style={s.formLabel}>Save address as</Text>
                  <View style={s.tagRow}>
                    {(['Home', 'Work', 'Other'] as AddressTag[]).map(tag => {
                      const active = addressTag === tag;
                      return (
                        <TouchableOpacity
                          key={tag}
                          style={[s.tagBtn, active && s.tagBtnActive]}
                          onPress={() => setAddressTag(tag)}
                          activeOpacity={0.75}
                        >
                          <Feather name={TAG_ICONS[tag]} size={13} color={active ? C.amber : C.muted} />
                          <Text style={[s.tagBtnText, active && s.tagBtnTextActive]}>{tag}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Flat + Floor row */}
                  <View style={s.fieldRow}>
                    <TextInput
                      style={[s.field, s.fieldHalf]}
                      placeholder="Flat / House No.*"
                      placeholderTextColor={C.muted}
                      value={flatNo}
                      onChangeText={setFlatNo}
                      returnKeyType="next"
                      keyboardAppearance="dark"
                    />
                    <TextInput
                      style={[s.field, s.fieldHalf]}
                      placeholder="Floor (Optional)"
                      placeholderTextColor={C.muted}
                      value={floor}
                      onChangeText={setFloor}
                      returnKeyType="next"
                      keyboardAppearance="dark"
                    />
                  </View>

                  {/* Building name */}
                  <TextInput
                    style={s.field}
                    placeholder="Apartment / Building name*"
                    placeholderTextColor={C.muted}
                    value={buildingName}
                    onChangeText={setBuildingName}
                    keyboardAppearance="dark"
                  />

                  {/* Landmark */}
                  <TextInput
                    style={[s.field, s.fieldLast]}
                    placeholder="Nearby Landmark (Optional)"
                    placeholderTextColor={C.muted}
                    value={landmark}
                    onChangeText={setLandmark}
                    keyboardAppearance="dark"
                  />
                </View>

                {/* ── Area card ── */}
                <View style={s.areaCard}>
                  <Text style={s.areaLabel}>Area / Sector / Locality*</Text>
                  <View style={s.areaRow}>
                    <Text style={s.areaAddress} numberOfLines={2}>{selectedPlace?.name}</Text>
                    <TouchableOpacity style={s.areaChangeBtn} onPress={() => setStep('search')} activeOpacity={0.75}>
                      <Text style={s.areaChangeBtnText}>Change</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* ── Receiver details card ── */}
                <View style={s.formCard}>
                  <Text style={s.formCardTitle}>Receiver details</Text>
                  <Text style={s.formCardSubtitle}>Our professional will reach out to you on this number.</Text>

                  {/* Phone field with prefix */}
                  <View style={[s.field, s.phoneField]}>
                    <View style={s.phonePrefix}>
                      <Text style={s.phonePrefixText}>+91</Text>
                      <View style={s.phonePrefixDivider} />
                    </View>
                    <TextInput
                      style={s.phoneInput}
                      placeholder="Phone number*"
                      placeholderTextColor={C.muted}
                      value={receiverPhone}
                      onChangeText={setReceiverPhone}
                      keyboardType="phone-pad"
                      maxLength={10}
                      keyboardAppearance="dark"
                    />
                  </View>

                  {/* Name field */}
                  <TextInput
                    style={[s.field, s.fieldLast]}
                    placeholder="Receiver's name*"
                    placeholderTextColor={C.muted}
                    value={receiverName}
                    onChangeText={setReceiverName}
                    keyboardAppearance="dark"
                  />
                </View>

                <View style={{ height: 100 }} />
              </ScrollView>

              {/* Save button — sticky at bottom */}
              <View style={s.saveWrap}>
                <TouchableOpacity
                  style={[s.saveBtn, !canSave && s.saveBtnDisabled]}
                  onPress={saveAddress}
                  disabled={!canSave}
                  activeOpacity={0.85}
                >
                  <Text style={[s.saveBtnText, !canSave && s.saveBtnTextDisabled]}>Save address</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

        </Animated.View>
      </View>
    </Modal>

    <EditAddressModal
      address={editTarget}
      token={token}
      onClose={() => setEditTarget(null)}
      onSaved={updated => {
        setSavedAddresses(prev => prev.map(a => a.id === updated.id ? updated : a));
        setEditTarget(null);
      }}
      onDeleted={handleSavedDeleted}
    />
    </>
  );
}

// ── Swipeable saved-address row ───────────────────────────────────────────────

const SWIPE_W = 76;

function SwipeSavedRow({
  addr, token, onSelect, onEdit, onDeleted,
}: {
  addr: ApiAddress;
  token: string | null;
  onSelect: () => void;
  onEdit: () => void;
  onDeleted: (id: string) => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const state = useRef<'closed' | 'left' | 'right'>('closed');

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderMove: (_, g) => {
      const base = state.current === 'left' ? -SWIPE_W : state.current === 'right' ? SWIPE_W : 0;
      translateX.setValue(Math.max(-SWIPE_W, Math.min(SWIPE_W, base + g.dx)));
    },
    onPanResponderRelease: (_, g) => {
      if (state.current === 'closed') {
        if (g.dx < -30) { snap(-SWIPE_W); state.current = 'left'; }
        else if (g.dx > 30) { snap(SWIPE_W); state.current = 'right'; }
        else snap(0);
      } else {
        const back = (state.current === 'left' && g.dx > 20) || (state.current === 'right' && g.dx < -20);
        if (back) { snap(0); state.current = 'closed'; }
        else snap(state.current === 'left' ? -SWIPE_W : SWIPE_W);
      }
    },
  })).current;

  function snap(to: number) {
    Animated.spring(translateX, { toValue: to, useNativeDriver: true, bounciness: 4 }).start();
    if (to === 0) state.current = 'closed';
  }

  function handleDelete() {
    Alert.alert('Delete Address', 'Delete this saved address?', [
      { text: 'Cancel', style: 'cancel', onPress: () => snap(0) },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          if (!token) return;
          try { await deleteAddress(token, addr.id); onDeleted(addr.id); }
          catch (err: any) { showError(err?.message ?? 'Could not delete. Try again.', { title: 'Cannot delete' }); snap(0); }
        },
      },
    ]);
  }

  return (
    <View style={ss.wrap}>
      {/* Delete — swipe right reveals on left */}
      <View style={[ss.action, ss.actionLeft]}>
        <TouchableOpacity style={ss.deleteBtn} onPress={handleDelete} activeOpacity={0.85}>
          <Feather name="trash-2" size={16} color="#FFFFFF" />
          <Text style={ss.actionText}>Delete</Text>
        </TouchableOpacity>
      </View>
      {/* Edit — swipe left reveals on right */}
      <View style={[ss.action, ss.actionRight]}>
        <TouchableOpacity style={ss.editBtn} onPress={() => { snap(0); onEdit(); }} activeOpacity={0.85}>
          <Feather name="edit-2" size={16} color="#0A0A0A" />
          <Text style={[ss.actionText, { color: '#0A0A0A' }]}>Edit</Text>
        </TouchableOpacity>
      </View>
      <Animated.View style={[ss.row, { transform: [{ translateX }] }]} {...pan.panHandlers}>
        <TouchableOpacity style={ss.rowInner} onPress={onSelect} activeOpacity={0.7}>
          <View style={ss.iconBox}>
            <Feather name={TAG_ICONS[addr.tag]} size={15} color={C.amber} />
          </View>
          <View style={ss.textCol}>
            <View style={ss.titleRow}>
              <Text style={ss.title} numberOfLines={1}>{addr.title}</Text>
              <View style={ss.tagPill}><Text style={ss.tagText}>{addr.tag}</Text></View>
            </View>
            <Text style={ss.sub} numberOfLines={1}>{addr.full_address}</Text>
          </View>
          <Feather name="chevron-right" size={13} color={C.faint} />
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const ss = StyleSheet.create({
  wrap: { height: 64, marginBottom: 8, borderRadius: 14, overflow: 'hidden' },
  action: { position: 'absolute', top: 0, bottom: 0, width: SWIPE_W },
  actionLeft: { left: 0 },
  actionRight: { right: 0 },
  deleteBtn: {
    flex: 1, backgroundColor: C.danger,
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  editBtn: {
    flex: 1, backgroundColor: C.amber,
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  actionText: { ...fontBold, fontSize: 11, color: '#FFFFFF', letterSpacing: 0.2 },
  row: {
    backgroundColor: 'rgba(20,20,26,0.92)',
    height: 64, borderRadius: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.10)',
  },
  rowInner: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12 },
  iconBox: {
    width: 36, height: 36, borderRadius: 12,
    backgroundColor: C.amberFill,
    alignItems: 'center', justifyContent: 'center',
  },
  textCol: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  title: { ...fontBold, fontSize: 13.5, color: C.text, letterSpacing: -0.1 },
  tagPill: { backgroundColor: C.amberFill, borderRadius: 99, paddingHorizontal: 7, paddingVertical: 1 },
  tagText: { ...fontSemi, fontSize: 9.5, color: C.amberHi, letterSpacing: 0.4 },
  sub: { ...fontMed, fontSize: 11.5, color: C.sub, lineHeight: 15 },
});

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.6)' },
  panelContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: PANEL_BOTTOM,
  },
  panel: {
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    backgroundColor: '#1A1A1F',
    borderRadius: 26,
    overflow: 'hidden',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.12)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 22 },
    shadowOpacity: 0.55,
    shadowRadius: 44,
    elevation: 16,
  },

  // ── Drag handle ──
  dragArea: { alignItems: 'center', paddingVertical: 10 },
  dragHandle: { width: 40, height: 4, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.18)' },

  // ── Shared header ──
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, gap: 10 },
  iconBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: C.glassFill,
    borderWidth: 0.5, borderColor: C.glassBorderStrong,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { ...fontBold, fontSize: 16, color: C.text, letterSpacing: -0.3 },
  headerDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.divider, marginHorizontal: 16, marginBottom: 12 },

  // ── Search ──
  searchWrap: { paddingHorizontal: 16, marginBottom: 12 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.glassFill,
    borderRadius: 14, paddingHorizontal: 14,
    height: 46, gap: 10,
    borderWidth: 0.5, borderColor: C.glassBorder,
  },
  searchBarConfirmed: { borderColor: C.amberBorder, backgroundColor: C.amberFill },
  searchInput: { flex: 1, ...fontMed, fontSize: 14, color: C.text, paddingVertical: 0 },
  clearBtn: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: C.glassFillStrong,
    borderWidth: 0.5, borderColor: C.glassBorderStrong,
    alignItems: 'center', justifyContent: 'center',
  },

  // ── Map ──
  mapWrap: {
    marginHorizontal: 16, borderRadius: 16, overflow: 'hidden',
    marginBottom: 10,
    borderWidth: 0.5, borderColor: C.glassBorderStrong,
  },
  map: { height: 170, width: '100%' },
  zopMarker: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#F5A300',
    borderWidth: 2.5, borderColor: 'rgba(180,180,180,0.9)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  centerPinContainer: { position: 'absolute', top: '47%', left: '50%', transform: [{ translateX: -12 }, { translateY: -36 }], alignItems: 'center' },
  centerPinHead: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: C.amber,
    borderWidth: 3, borderColor: C.bg,
    shadowColor: C.amber, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  centerPinTail: {
    width: 0, height: 0,
    borderLeftWidth: 8, borderRightWidth: 8, borderTopWidth: 18,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderTopColor: C.amber, marginTop: -2,
  },
  mapHint: { ...fontReg, fontSize: 11.5, color: C.muted, marginBottom: 8 },

  // ── Confirm strip ──
  confirmWrap: { marginHorizontal: 16, marginBottom: 8 },
  confirmAddressRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 12 },
  pinDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.amber, flexShrink: 0, marginTop: 5 },
  confirmAddressText: { flex: 1, ...fontSemi, fontSize: 13, color: C.text, lineHeight: 19 },
  confirmActions: { flexDirection: 'row', gap: 8 },
  changeBtn: {
    flex: 1, height: 44, borderRadius: 14,
    borderWidth: 0.5, borderColor: C.glassBorderStrong,
    backgroundColor: C.glassFill,
    alignItems: 'center', justifyContent: 'center',
  },
  changeBtnText: { ...fontSemi, fontSize: 13, color: C.text },
  confirmBtn: {
    flex: 2, height: 44, borderRadius: 14,
    backgroundColor: C.amber,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.amber, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  confirmBtnText: { ...fontBold, fontSize: 13.5, color: C.bg, letterSpacing: 0.2 },

  // ── Primary actions ──
  primaryActions: {
    marginHorizontal: 16,
    backgroundColor: C.glassFill,
    borderRadius: 16,
    borderWidth: 0.5, borderColor: C.glassBorder,
    marginBottom: 12, overflow: 'hidden',
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 12 },
  actionDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.divider, marginLeft: 14 + 40 + 12 },
  actionIconBox: {
    width: 40, height: 40, borderRadius: 12,
    borderWidth: 0.5,
    alignItems: 'center', justifyContent: 'center',
  },
  actionTextCol: { flex: 1 },
  actionTitle: { ...fontSemi, fontSize: 13.5, color: C.text, letterSpacing: -0.1 },
  actionSub: { ...fontMed, fontSize: 11, color: C.muted, marginTop: 2 },
  actionError: { ...fontMed, fontSize: 11, color: C.danger, marginTop: 2 },

  // ── Results scroll ──
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 24 },
  resultRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  resultIconBox: {
    width: 36, height: 36, borderRadius: 12,
    backgroundColor: C.amberFill,
    alignItems: 'center', justifyContent: 'center',
  },
  resultTextCol: { flex: 1, minWidth: 0 },
  resultPrimary: { ...fontSemi, fontSize: 13.5, color: C.text, marginBottom: 2 },
  resultSecondary: { ...fontMed, fontSize: 11.5, color: C.muted },
  rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.divider, marginLeft: 36 + 12 },
  sectionLabel: { ...fontBold, fontSize: 10, color: C.muted, letterSpacing: 1.0, marginBottom: 10, marginTop: 6, textTransform: 'uppercase' },

  emptyState: { alignItems: 'center', paddingVertical: 32, gap: 8 },
  emptyIconWrap: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.amberFill,
    borderWidth: 1, borderColor: C.amberBorder,
    marginBottom: 6,
  },
  emptyTitle: { ...fontBold, fontSize: 15, color: C.text, letterSpacing: -0.2 },
  emptySubtitle: { ...fontMed, fontSize: 12.5, color: C.muted },
  retryText: { ...fontSemi, fontSize: 13, color: C.amber, textDecorationLine: 'underline', marginTop: 4 },

  // ══════════════════════════════════════════════
  // Step 2 — Address details form
  // ══════════════════════════════════════════════

  detailsRoot: { flex: 1 },

  detailsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 12,
    gap: 12,
  },
  detailsHeaderTitle: { ...fontBold, fontSize: 18, color: C.text, letterSpacing: -0.3 },

  detailsScroll: { flex: 1 },
  detailsScrollContent: { paddingHorizontal: 16, paddingTop: 4 },

  // ── Form card ──
  formCard: {
    backgroundColor: C.glassFill,
    borderRadius: 16,
    borderWidth: 0.5, borderColor: C.glassBorder,
    padding: 16,
    marginBottom: 12,
  },
  formCardTitle: { ...fontBold, fontSize: 14.5, color: C.text, marginBottom: 4, letterSpacing: -0.2 },
  formCardSubtitle: { ...fontReg, fontSize: 12, color: C.muted, marginBottom: 14, lineHeight: 17 },
  formLabel: { ...fontMed, fontSize: 12, color: C.muted, marginBottom: 10, marginTop: 10, letterSpacing: 0.2 },

  // ── Tag selector ──
  tagRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tagBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 40,
    borderRadius: 12,
    borderWidth: 0.5, borderColor: C.glassBorderStrong,
    backgroundColor: C.glassFill,
  },
  tagBtnActive: { borderColor: C.amberBorder, backgroundColor: C.amberFill },
  tagBtnText: { ...fontSemi, fontSize: 12.5, color: C.muted },
  tagBtnTextActive: { color: C.amberHi },

  // ── Input fields ──
  fieldRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  fieldHalf: { flex: 1, marginBottom: 0 },
  field: {
    backgroundColor: C.glassFill,
    borderRadius: 12,
    borderWidth: 0.5, borderColor: C.glassBorder,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 13 : 11,
    ...fontMed,
    fontSize: 13.5,
    color: C.text,
    marginBottom: 10,
  },
  fieldLast: { marginBottom: 0 },

  // ── Phone field ──
  phoneField: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 0,
    paddingVertical: 0,
    overflow: 'hidden',
  },
  phonePrefix: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, height: '100%' },
  phonePrefixText: { ...fontSemi, fontSize: 13.5, color: C.text },
  phonePrefixDivider: { width: StyleSheet.hairlineWidth, height: 20, backgroundColor: C.glassBorderStrong, marginLeft: 10 },
  phoneInput: {
    flex: 1,
    ...fontMed, fontSize: 13.5, color: C.text,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 13 : 11,
  },

  // ── Area card ──
  areaCard: {
    backgroundColor: C.glassFill,
    borderRadius: 16,
    borderWidth: 0.5, borderColor: C.glassBorder,
    padding: 16,
    marginBottom: 12,
  },
  areaLabel: { ...fontMed, fontSize: 12, color: C.muted, marginBottom: 8, letterSpacing: 0.2 },
  areaRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  areaAddress: { flex: 1, ...fontBold, fontSize: 13.5, color: C.text, lineHeight: 19 },
  areaChangeBtn: {
    backgroundColor: C.amberFill,
    borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 0.5, borderColor: C.amberBorder,
  },
  areaChangeBtnText: { ...fontBold, fontSize: 11.5, color: C.amberHi, letterSpacing: 0.2 },

  // ── Save button ──
  saveWrap: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 22 : 16,
    paddingTop: 12,
    backgroundColor: 'rgba(15,15,20,0.88)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.10)',
  },
  saveBtn: {
    height: 52,
    borderRadius: 14,
    backgroundColor: C.amber,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.amber, shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  saveBtnDisabled: {
    backgroundColor: C.glassFillStrong,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveBtnText: { ...fontBold, fontSize: 14, color: C.bg, letterSpacing: 0.3 },
  saveBtnTextDisabled: { color: C.muted },
});
