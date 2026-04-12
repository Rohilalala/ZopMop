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
  ActivityIndicator,
  Animated,
  PanResponder,
  Dimensions,
  Platform,
  Keyboard,
  Alert,
} from 'react-native';
import * as Location from 'expo-location';
import MapView, { PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../theme';
import { useAuth } from '../context/AuthContext';
import { listAddresses, createAddress, deleteAddress, type ApiAddress } from '../api/addresses';
import EditAddressModal from './EditAddressModal';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const PANEL_WIDTH = SCREEN_WIDTH * 0.92;
const PANEL_HEIGHT = SCREEN_HEIGHT * 0.82;
const PANEL_BOTTOM = Platform.OS === 'ios' ? 36 : 16;

const DEFAULT_REGION: Region = {
  latitude: 28.4595,
  longitude: 77.0266,
  latitudeDelta: 0.001,
  longitudeDelta: 0.001,
};

const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#f9fafb' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6b7280' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#111827' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#d1fae5' }, { visibility: 'on' }] },
  { featureType: 'poi.park', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e5e7eb' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9ca3af' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#f3f4f6' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#eef2ff' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#818cf8' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#4f46e5' }] },
  { featureType: 'road.local', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#ccfbf1' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#0d9488' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#f3f4f6' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#f0fdf4' }] },
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

interface GeocodedResult {
  name: string;
  lat: number;
  lon: number;
}

interface SelectedPlace {
  name: string;
  lat: number;
  lon: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onLocationSelect: (name: string, lat: number, lon: number) => void;
}

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
    }
  }, [visible]);

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

  // Uses expo-location's on-device geocoder — no API key compiled into the bundle.
  // iOS resolves via Apple Maps; Android uses the device's built-in geocoding service.
  async function fetchSearch(query: string) {
    try {
      const coords = await Location.geocodeAsync(query);
      if (coords.length === 0) { setSearchState('no_results'); setResults([]); return; }
      // Reverse-geocode the top result to produce a human-readable label.
      const [top] = coords;
      const [place] = await Location.reverseGeocodeAsync({
        latitude: top.latitude,
        longitude: top.longitude,
      });
      const label = place
        ? [place.name, place.district ?? place.subregion ?? place.city].filter(Boolean).join(', ')
        : query;
      setSearchState('results');
      setResults([{ name: label || query, lat: top.latitude, lon: top.longitude }]);
    } catch { setSearchState('error'); }
  }

  async function handleResultSelect(result: GeocodedResult) {
    setSelectedPlace({ name: result.name, lat: result.lat, lon: result.lon });
    setSearchQuery(result.name);
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
    // Directly select the saved address and close
    onLocationSelect(addr.full_address, addr.lat, addr.lon);
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
                <TouchableOpacity style={s.closeBtn} onPress={dismissModal} activeOpacity={0.7} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Text style={s.closeBtnText}>✕</Text>
                </TouchableOpacity>
                <Text style={s.headerTitle}>Search your location</Text>
              </View>

              <View style={s.headerDivider} />

              {/* Search bar */}
              <View style={s.searchWrap}>
                <View style={[s.searchBar, selectedPlace ? s.searchBarConfirmed : null]}>
                  {searchState === 'loading'
                    ? <ActivityIndicator size="small" color={Colors.primary} style={s.searchIconPlaceholder} />
                    : <View style={s.searchIconBox}><View style={s.searchCircle} /><View style={s.searchHandle} /></View>
                  }
                  <TextInput
                    ref={searchInputRef}
                    style={s.searchInput}
                    placeholder="Search locality, sector, area"
                    placeholderTextColor={Colors.textMuted}
                    value={searchQuery}
                    onChangeText={handleSearchChange}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                  />
                  {searchQuery.length > 0 && (
                    <TouchableOpacity style={s.clearBtn} onPress={() => handleSearchChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={s.clearBtnText}>✕</Text>
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
                />
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
                    <View style={[s.actionIconBox, { backgroundColor: Colors.primaryBg }]}>
                      {gpsState === 'loading'
                        ? <ActivityIndicator size="small" color={Colors.primary} />
                        : <View style={s.gpsOuter}><View style={s.gpsInner} /></View>
                      }
                    </View>
                    <View style={s.actionTextCol}>
                      <Text style={s.actionTitle}>{gpsState === 'loading' ? 'Detecting location…' : 'Use current location'}</Text>
                      {gpsState === 'denied' && <Text style={s.actionError}>Permission denied — tap to retry</Text>}
                    </View>
                  </TouchableOpacity>
                  <View style={s.actionDivider} />
                  <TouchableOpacity
                    style={s.actionRow}
                    onPress={() => searchInputRef.current?.focus()}
                    activeOpacity={0.7}
                  >
                    <View style={[s.actionIconBox, { backgroundColor: '#F0FDF4' }]}>
                      <Text style={s.addText}>+</Text>
                    </View>
                    <View style={s.actionTextCol}>
                      <Text style={s.actionTitle}>Add new address</Text>
                      <Text style={{ fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 }}>Search your area in the bar above</Text>
                    </View>
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
                          <><View style={s.resultPinHead} /><View style={s.resultPinTail} /></>
                        </View>
                        <View style={s.resultTextCol}>
                          <Text style={s.resultPrimary} numberOfLines={2}>{result.name}</Text>
                        </View>
                      </TouchableOpacity>
                      {idx < results.length - 1 && <View style={s.rowDivider} />}
                    </React.Fragment>
                  ))}

                  {searchState === 'no_results' && (
                    <View style={s.emptyState}>
                      <Text style={s.emptyEmoji}>🗺️</Text>
                      <Text style={s.emptyTitle}>No results found</Text>
                      <Text style={s.emptySubtitle}>Try a different area or locality</Text>
                    </View>
                  )}

                  {searchState === 'error' && (
                    <View style={s.emptyState}>
                      <Text style={s.emptyEmoji}>⚠️</Text>
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
                <TouchableOpacity style={s.backBtn} onPress={() => setStep('search')} activeOpacity={0.7} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Text style={s.backBtnText}>←</Text>
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
                    {(['Home', 'Work', 'Other'] as AddressTag[]).map(tag => (
                      <TouchableOpacity
                        key={tag}
                        style={[s.tagBtn, addressTag === tag && s.tagBtnActive]}
                        onPress={() => setAddressTag(tag)}
                        activeOpacity={0.75}
                      >
                        <Text style={[s.tagBtnText, addressTag === tag && s.tagBtnTextActive]}>{tag}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* Flat + Floor row */}
                  <View style={s.fieldRow}>
                    <TextInput
                      style={[s.field, s.fieldHalf]}
                      placeholder="Flat / House No.*"
                      placeholderTextColor={Colors.textMuted}
                      value={flatNo}
                      onChangeText={setFlatNo}
                      returnKeyType="next"
                    />
                    <TextInput
                      style={[s.field, s.fieldHalf]}
                      placeholder="Floor (Optional)"
                      placeholderTextColor={Colors.textMuted}
                      value={floor}
                      onChangeText={setFloor}
                      returnKeyType="next"
                    />
                  </View>

                  {/* Building name */}
                  <TextInput
                    style={s.field}
                    placeholder="Apartment / Building name*"
                    placeholderTextColor={Colors.textMuted}
                    value={buildingName}
                    onChangeText={setBuildingName}

                  />

                  {/* Landmark */}
                  <TextInput
                    style={[s.field, s.fieldLast]}
                    placeholder="Nearby Landmark (Optional)"
                    placeholderTextColor={Colors.textMuted}
                    value={landmark}
                    onChangeText={setLandmark}

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
                      placeholderTextColor={Colors.textMuted}
                      value={receiverPhone}
                      onChangeText={setReceiverPhone}
                      keyboardType="phone-pad"
                      maxLength={10}
                    />
                  </View>

                  {/* Name field */}
                  <TextInput
                    style={[s.field, s.fieldLast]}
                    placeholder="Receiver's name*"
                    placeholderTextColor={Colors.textMuted}
                    value={receiverName}
                    onChangeText={setReceiverName}

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

const SWIPE_W = 72;

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
          catch { Alert.alert('Error', 'Could not delete. Try again.'); snap(0); }
        },
      },
    ]);
  }

  return (
    <View style={ss.wrap}>
      {/* Delete — swipe right */}
      <View style={[ss.action, ss.actionLeft]}>
        <TouchableOpacity style={ss.deleteBtn} onPress={handleDelete} activeOpacity={0.85}>
          <Text style={ss.actionText}>🗑</Text>
        </TouchableOpacity>
      </View>
      {/* Edit — swipe left */}
      <View style={[ss.action, ss.actionRight]}>
        <TouchableOpacity style={ss.editBtn} onPress={() => { snap(0); onEdit(); }} activeOpacity={0.85}>
          <Text style={ss.actionText}>✏️</Text>
        </TouchableOpacity>
      </View>
      <Animated.View style={[ss.row, { transform: [{ translateX }] }]} {...pan.panHandlers}>
        <TouchableOpacity style={ss.rowInner} onPress={onSelect} activeOpacity={0.7}>
          <View style={ss.iconBox}>
            <View style={[s.resultPinHead, { width: 10, height: 10 }]} />
            <View style={[s.resultPinTail, { borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7 }]} />
          </View>
          <View style={ss.textCol}>
            <View style={ss.titleRow}>
              <Text style={ss.title}>{addr.title}</Text>
              <View style={s.tagPill}><Text style={s.tagText}>{addr.tag}</Text></View>
            </View>
            <Text style={ss.sub} numberOfLines={1}>{addr.full_address}</Text>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const ss = StyleSheet.create({
  wrap: { height: 60, marginBottom: 2, borderRadius: Radius.lg, overflow: 'hidden' },
  action: { position: 'absolute', top: 0, bottom: 0, width: SWIPE_W },
  actionLeft: { left: 0 },
  actionRight: { right: 0 },
  deleteBtn: { flex: 1, backgroundColor: Colors.danger, alignItems: 'center', justifyContent: 'center', borderTopLeftRadius: Radius.lg, borderBottomLeftRadius: Radius.lg },
  editBtn: { flex: 1, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', borderTopRightRadius: Radius.lg, borderBottomRightRadius: Radius.lg },
  actionText: { fontSize: 18 },
  row: { backgroundColor: Colors.white, height: 60, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border },
  rowInner: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 10 },
  iconBox: { width: 32, height: 32, borderRadius: Radius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  textCol: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  title: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.text },
  sub: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textSecondary },
});

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.45)' },
  panelContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: PANEL_BOTTOM,
  },
  panel: {
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    backgroundColor: Colors.white,
    borderRadius: 22,
    overflow: 'hidden',
    ...Shadow.lg,
  },

  // ── Drag handle ──
  dragArea: { alignItems: 'center', paddingVertical: 10 },
  dragHandle: { width: 36, height: 4, borderRadius: Radius.full, backgroundColor: Colors.border },

  // ── Shared header ──
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.base, paddingBottom: 12, gap: 10 },
  closeBtn: { width: 30, height: 30, borderRadius: Radius.full, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { fontSize: 12, color: Colors.textSecondary, fontFamily: FontFamily.medium },
  headerTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.md, color: Colors.text, letterSpacing: -0.2 },
  headerDivider: { height: 1, backgroundColor: Colors.border, marginHorizontal: Spacing.base, marginBottom: 12 },

  // ── Search ──
  searchWrap: { paddingHorizontal: Spacing.base, marginBottom: 12 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl, paddingHorizontal: Spacing.md,
    height: 46, gap: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchBarConfirmed: { borderColor: Colors.primary, backgroundColor: Colors.primaryBg },
  searchIconPlaceholder: { width: 20 },
  searchIconBox: { width: 18, height: 18 },
  searchCircle: { width: 12, height: 12, borderRadius: Radius.full, borderWidth: 2, borderColor: Colors.textMuted, position: 'absolute', top: 0, left: 0 },
  searchHandle: { width: 6, height: 2, backgroundColor: Colors.textMuted, position: 'absolute', bottom: 1, right: 0, transform: [{ rotate: '45deg' }], borderRadius: 1 },
  searchInput: { flex: 1, fontFamily: FontFamily.regular, fontSize: FontSize.base, color: Colors.text, paddingVertical: 0 },
  clearBtn: { width: 20, height: 20, borderRadius: Radius.full, backgroundColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  clearBtnText: { fontSize: 9, color: Colors.textSecondary, fontFamily: FontFamily.bold },

  // ── Map ──
  mapWrap: { marginHorizontal: Spacing.base, borderRadius: Radius.xl, overflow: 'hidden', marginBottom: 10, borderWidth: 1, borderColor: Colors.border },
  map: { height: 160, width: '100%' },
  centerPinContainer: { position: 'absolute', top: '47%', left: '50%', transform: [{ translateX: -12 }, { translateY: -36 }], alignItems: 'center' },
  centerPinHead: { width: 24, height: 24, borderRadius: 12, backgroundColor: Colors.primary, borderWidth: 3, borderColor: Colors.white, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 5 },
  centerPinTail: { width: 0, height: 0, borderLeftWidth: 8, borderRightWidth: 8, borderTopWidth: 18, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: Colors.primary, marginTop: -2 },
  mapHint: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 8 },

  // ── Confirm strip ──
  confirmWrap: { marginHorizontal: Spacing.base, marginBottom: 8 },
  confirmAddressRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 10 },
  pinDot: { width: 8, height: 8, borderRadius: Radius.full, backgroundColor: Colors.primary, flexShrink: 0, marginTop: 3 },
  confirmAddressText: { flex: 1, fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: Colors.text, lineHeight: 20 },
  confirmActions: { flexDirection: 'row', gap: 8 },
  changeBtn: { flex: 1, height: 42, borderRadius: Radius.xl, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  changeBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.textSecondary },
  confirmBtn: { flex: 2, height: 42, borderRadius: Radius.xl, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', ...Shadow.sm },
  confirmBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.white, letterSpacing: 0.2 },

  // ── Primary actions ──
  primaryActions: { marginHorizontal: Spacing.base, backgroundColor: Colors.surface, borderRadius: Radius.xl, borderWidth: 1, borderColor: Colors.border, marginBottom: 12, overflow: 'hidden' },
  actionRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md, paddingVertical: 12, gap: 12 },
  actionDivider: { height: 1, backgroundColor: Colors.border, marginLeft: Spacing.md + 40 + 12 },
  actionIconBox: { width: 40, height: 40, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center' },
  gpsOuter: { width: 20, height: 20, borderRadius: Radius.full, borderWidth: 2, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  gpsInner: { width: 7, height: 7, borderRadius: Radius.full, backgroundColor: Colors.primary },
  addText: { fontFamily: FontFamily.bold, fontSize: 22, color: Colors.success, lineHeight: 26, marginTop: -1 },
  actionTextCol: { flex: 1 },
  actionTitle: { fontFamily: FontFamily.medium, fontSize: FontSize.base, color: Colors.text },
  actionError: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.danger, marginTop: 2 },

  // ── Results scroll ──
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.base, paddingBottom: Spacing.base },
  resultRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  resultIconBox: { width: 36, height: 36, borderRadius: Radius.md, backgroundColor: Colors.primaryBg, alignItems: 'center', justifyContent: 'center' },
  resultPinHead: { width: 12, height: 12, borderRadius: Radius.full, backgroundColor: Colors.primary, marginBottom: -2 },
  resultPinTail: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 9, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: Colors.primary },
  resultTextCol: { flex: 1 },
  resultPrimary: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.text, marginBottom: 2 },
  resultSecondary: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary },
  rowDivider: { height: 1, backgroundColor: Colors.border, marginLeft: 36 + 12 },
  sectionLabel: { fontFamily: FontFamily.bold, fontSize: FontSize.xs, color: Colors.textMuted, letterSpacing: 0.6, marginBottom: 8, marginTop: 4 },
  savedRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  savedIconBox: { width: 36, height: 36, borderRadius: Radius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  savedTextCol: { flex: 1 },
  savedTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  savedTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.base, color: Colors.text },
  tagPill: { backgroundColor: Colors.primaryBg, borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 2 },
  tagText: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs, color: Colors.primary },
  savedSubtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary },
  savedMeta: { fontFamily: FontFamily.regular, fontSize: 10, color: Colors.textMuted, marginLeft: 6 },
  emptyState: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.sm },
  emptyEmoji: { fontSize: 32, marginBottom: 4 },
  emptyTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: Colors.text },
  emptySubtitle: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textSecondary },
  retryText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: Colors.primary, textDecorationLine: 'underline', marginTop: 4 },

  // ══════════════════════════════════════════════
  // Step 2 — Address details form
  // ══════════════════════════════════════════════

  detailsRoot: { flex: 1 },

  detailsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingTop: 18,
    paddingBottom: 12,
    gap: 12,
  },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnText: { fontSize: 18, color: Colors.text, lineHeight: 22 },
  detailsHeaderTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: Colors.text, letterSpacing: -0.3 },

  detailsScroll: { flex: 1 },
  detailsScrollContent: { paddingHorizontal: Spacing.base, paddingTop: 4 },

  // ── Form card ──
  formCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
    marginBottom: 12,
    ...Shadow.sm,
  },
  formCardTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.md,
    color: Colors.text,
    marginBottom: 4,
    letterSpacing: -0.2,
  },
  formCardSubtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 16,
    lineHeight: 20,
  },
  formLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 10,
    marginTop: 12,
  },

  // ── Tag selector ──
  tagRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  tagBtn: {
    flex: 1,
    height: 40,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagBtnActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryBg,
  },
  tagBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  tagBtnTextActive: {
    color: Colors.primary,
  },

  // ── Input fields ──
  fieldRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  fieldHalf: { flex: 1, marginBottom: 0 },
  field: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.text,
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
  phonePrefix: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: Spacing.md,
    paddingRight: 0,
    height: '100%',
  },
  phonePrefixText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.text,
  },
  phonePrefixDivider: {
    width: 1,
    height: 20,
    backgroundColor: Colors.border,
    marginLeft: 10,
    marginRight: 2,
  },
  phoneInput: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.text,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 12,
  },

  // ── Area card ──
  areaCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.base,
    marginBottom: 12,
    ...Shadow.sm,
  },
  areaLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 8,
  },
  areaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  areaAddress: {
    flex: 1,
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    lineHeight: 22,
  },
  areaChangeBtn: {
    backgroundColor: `${Colors.accent}18`,
    borderRadius: Radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: `${Colors.accent}40`,
  },
  areaChangeBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.accent,
  },

  // ── Save button ──
  saveWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.base,
    paddingBottom: Platform.OS === 'ios' ? 20 : 16,
    paddingTop: 12,
    backgroundColor: Colors.white,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  saveBtn: {
    height: 52,
    borderRadius: Radius.xl,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.sm,
  },
  saveBtnDisabled: {
    backgroundColor: Colors.border,
  },
  saveBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.white,
    letterSpacing: 0.3,
  },
  saveBtnTextDisabled: {
    color: Colors.textMuted,
  },
});
