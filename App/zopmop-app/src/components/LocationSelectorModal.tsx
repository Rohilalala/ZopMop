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
} from 'react-native';
import * as Location from 'expo-location';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../theme';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const PANEL_WIDTH = SCREEN_WIDTH * 0.92;
const PANEL_HEIGHT = SCREEN_HEIGHT * 0.72;
const PANEL_BOTTOM = Platform.OS === 'ios' ? 36 : 16;

const API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

type SearchState = 'idle' | 'loading' | 'results' | 'no_results' | 'error';
type GpsState = 'idle' | 'loading' | 'denied';

interface PlacePrediction {
  placeId: string;
  text: { text: string };
  structuredFormat: {
    mainText: { text: string };
    secondaryText?: { text: string };
  };
}

interface SelectedPlace {
  name: string;
  lat: number;
  lon: number;
}

// Static saved addresses — swap with real data from API later
const SAVED_ADDRESSES = [
  { id: '1', tag: 'Home', title: 'Home', subtitle: 'A-123, Sector 51, Gurugram, Haryana' },
  { id: '2', tag: 'Work', title: 'Work', subtitle: 'Cyber Hub, DLF CyberCity, Gurugram' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  onLocationSelect: (name: string, lat: number, lon: number) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LocationSelectorModal({ visible, onClose, onLocationSelect }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [results, setResults] = useState<PlacePrediction[]>([]);
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null);
  const [fetchingPlaceId, setFetchingPlaceId] = useState<string | null>(null);

  const slideAnim = useRef(new Animated.Value(PANEL_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Animation ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (visible) {
      setIsOpen(true);
      slideAnim.setValue(PANEL_HEIGHT);
      fadeAnim.setValue(0);
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: 0, duration: 320, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  function dismissModal() {
    Keyboard.dismiss();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: PANEL_HEIGHT, duration: 280, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      setIsOpen(false);
      setSearchQuery('');
      setSearchState('idle');
      setResults([]);
      setGpsState('idle');
      setSelectedPlace(null);
      onClose();
    });
  }

  // ── Swipe-down gesture (drag handle only) ───────────────────────────────────

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, { dy }) => dy > 4,
      onPanResponderMove: (_, { dy }) => {
        if (dy > 0) slideAnim.setValue(dy);
      },
      onPanResponderRelease: (_, { dy, vy }) => {
        if (dy > PANEL_HEIGHT * 0.22 || vy > 1.0) {
          dismissModal();
        } else {
          Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        }
      },
    })
  ).current;

  // ── Search — Places Autocomplete (New) ──────────────────────────────────────

  function handleSearchChange(text: string) {
    setSearchQuery(text);
    if (selectedPlace) setSelectedPlace(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text.trim()) {
      setSearchState('idle');
      setResults([]);
      return;
    }
    setSearchState('loading');
    debounceRef.current = setTimeout(() => fetchSearch(text.trim()), 400);
  }

  async function fetchSearch(query: string) {
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
        },
        body: JSON.stringify({
          input: query,
          includedRegionCodes: ['IN'],
        }),
      });
      if (!res.ok) throw new Error('api_error');
      const data = await res.json();
      const suggestions: Array<{ placePrediction: PlacePrediction }> = data.suggestions ?? [];
      if (suggestions.length === 0) {
        setSearchState('no_results');
        setResults([]);
      } else {
        setSearchState('results');
        setResults(suggestions.map(s => s.placePrediction).slice(0, 8));
      }
    } catch {
      setSearchState('error');
    }
  }

  // ── Place details — lat/lon from placeId ────────────────────────────────────

  async function fetchPlaceDetails(placeId: string): Promise<{ latitude: number; longitude: number }> {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'location',
      },
    });
    if (!res.ok) throw new Error('api_error');
    const data = await res.json();
    return data.location;
  }

  async function handleResultSelect(prediction: PlacePrediction) {
    setFetchingPlaceId(prediction.placeId);
    try {
      const location = await fetchPlaceDetails(prediction.placeId);
      setSelectedPlace({
        name: prediction.text.text,
        lat: location.latitude,
        lon: location.longitude,
      });
      setSearchQuery(prediction.structuredFormat.mainText.text);
      setSearchState('idle');
      setResults([]);
      Keyboard.dismiss();
    } catch {
      // stay in results — let user retry
    } finally {
      setFetchingPlaceId(null);
    }
  }

  // ── GPS — Geocoding API reverse ─────────────────────────────────────────────

  async function handleGps() {
    setGpsState('loading');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setGpsState('denied'); return; }

      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;

      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${API_KEY}`
      );
      if (!res.ok) throw new Error('api_error');
      const data = await res.json();
      const address: string = data.results?.[0]?.formatted_address ?? 'Current Location';

      setSelectedPlace({ name: address, lat: latitude, lon: longitude });
      setGpsState('idle');
      Keyboard.dismiss();
    } catch {
      setGpsState('denied');
    }
  }

  // ── Saved address select ────────────────────────────────────────────────────

  function handleSavedSelect(addr: typeof SAVED_ADDRESSES[0]) {
    // Real implementation would store lat/lon with the address
    setSelectedPlace({ name: addr.subtitle, lat: 28.4595, lon: 77.0266 });
    setSearchQuery(addr.title);
    Keyboard.dismiss();
  }

  // ── Confirm ─────────────────────────────────────────────────────────────────

  function confirmSelection() {
    if (!selectedPlace) return;
    onLocationSelect(selectedPlace.name, selectedPlace.lat, selectedPlace.lon);
    dismissModal();
  }

  const showIdle = searchState === 'idle' && !selectedPlace;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <Modal
      transparent
      visible={isOpen}
      onRequestClose={dismissModal}
      statusBarTranslucent
      animationType="none"
    >
      {/* Backdrop */}
      <TouchableWithoutFeedback onPress={dismissModal}>
        <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: fadeAnim }]} />
      </TouchableWithoutFeedback>

      {/* Panel */}
      <View style={s.panelContainer} pointerEvents="box-none">
        <Animated.View style={[s.panel, { transform: [{ translateY: slideAnim }] }]}>

          {/* Drag handle */}
          <View {...panResponder.panHandlers} style={s.dragArea}>
            <View style={s.dragHandle} />
          </View>

          {/* Header */}
          <View style={s.header}>
            <TouchableOpacity
              style={s.closeBtn}
              onPress={dismissModal}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={s.closeBtnText}>✕</Text>
            </TouchableOpacity>
            <Text style={s.headerTitle}>Search your location</Text>
          </View>

          <View style={s.headerDivider} />

          {/* Search bar */}
          <View style={s.searchWrap}>
            <View style={[s.searchBar, selectedPlace ? s.searchBarConfirmed : null]}>
              {searchState === 'loading' ? (
                <ActivityIndicator size="small" color={Colors.primary} style={s.searchIconPlaceholder} />
              ) : (
                <View style={s.searchIconBox}>
                  <View style={s.searchCircle} />
                  <View style={s.searchHandle} />
                </View>
              )}
              <TextInput
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
                <TouchableOpacity
                  style={s.clearBtn}
                  onPress={() => handleSearchChange('')}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={s.clearBtnText}>✕</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* ── Map preview (shown after selection) ── */}
          {selectedPlace && (
            <View style={s.mapWrap}>
              <MapView
                provider={PROVIDER_GOOGLE}
                style={s.map}
                region={{
                  latitude: selectedPlace.lat,
                  longitude: selectedPlace.lon,
                  latitudeDelta: 0.008,
                  longitudeDelta: 0.008,
                }}
                scrollEnabled={false}
                zoomEnabled={false}
                rotateEnabled={false}
                pitchEnabled={false}
              >
                <Marker
                  coordinate={{ latitude: selectedPlace.lat, longitude: selectedPlace.lon }}
                />
              </MapView>

              {/* Address row */}
              <View style={s.mapAddressRow}>
                <View style={s.mapPinDot} />
                <Text style={s.mapAddressText} numberOfLines={2}>{selectedPlace.name}</Text>
              </View>

              {/* Actions */}
              <View style={s.mapActions}>
                <TouchableOpacity
                  style={s.changeBtn}
                  onPress={() => { setSelectedPlace(null); setSearchQuery(''); }}
                  activeOpacity={0.7}
                >
                  <Text style={s.changeBtnText}>Change</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.confirmBtn} onPress={confirmSelection} activeOpacity={0.85}>
                  <Text style={s.confirmBtnText}>Confirm Location</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Primary actions (GPS + Add address) ── */}
          {showIdle && (
            <View style={s.primaryActions}>
              <TouchableOpacity
                style={s.actionRow}
                onPress={handleGps}
                disabled={gpsState === 'loading'}
                activeOpacity={0.7}
              >
                <View style={[s.actionIconBox, { backgroundColor: Colors.primaryBg }]}>
                  {gpsState === 'loading' ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : (
                    <View style={s.gpsOuter}><View style={s.gpsInner} /></View>
                  )}
                </View>
                <View style={s.actionTextCol}>
                  <Text style={s.actionTitle}>
                    {gpsState === 'loading' ? 'Detecting location…' : 'Use current location'}
                  </Text>
                  {gpsState === 'denied' && (
                    <Text style={s.actionError}>Permission denied — tap to retry</Text>
                  )}
                </View>
              </TouchableOpacity>

              <View style={s.actionDivider} />

              <TouchableOpacity style={s.actionRow} activeOpacity={0.7}>
                <View style={[s.actionIconBox, { backgroundColor: Colors.successBg }]}>
                  <Text style={s.addText}>+</Text>
                </View>
                <Text style={s.actionTitle}>Add address</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Scroll area (hidden in preview mode) ── */}
          {!selectedPlace && (
            <ScrollView
              style={s.scroll}
              contentContainerStyle={s.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Search results */}
              {searchState === 'results' && results.map((prediction, idx) => (
                <React.Fragment key={prediction.placeId}>
                  <TouchableOpacity
                    style={s.resultRow}
                    onPress={() => handleResultSelect(prediction)}
                    disabled={fetchingPlaceId !== null}
                    activeOpacity={0.7}
                  >
                    <View style={s.resultIconBox}>
                      {fetchingPlaceId === prediction.placeId ? (
                        <ActivityIndicator size="small" color={Colors.primary} />
                      ) : (
                        <>
                          <View style={s.resultPinHead} />
                          <View style={s.resultPinTail} />
                        </>
                      )}
                    </View>
                    <View style={s.resultTextCol}>
                      <Text style={s.resultPrimary} numberOfLines={1}>
                        {prediction.structuredFormat.mainText.text}
                      </Text>
                      {prediction.structuredFormat.secondaryText && (
                        <Text style={s.resultSecondary} numberOfLines={1}>
                          {prediction.structuredFormat.secondaryText.text}
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                  {idx < results.length - 1 && <View style={s.rowDivider} />}
                </React.Fragment>
              ))}

              {/* No results */}
              {searchState === 'no_results' && (
                <View style={s.emptyState}>
                  <Text style={s.emptyEmoji}>🗺️</Text>
                  <Text style={s.emptyTitle}>No results found</Text>
                  <Text style={s.emptySubtitle}>Try a different area or locality</Text>
                </View>
              )}

              {/* Error */}
              {searchState === 'error' && (
                <View style={s.emptyState}>
                  <Text style={s.emptyEmoji}>⚠️</Text>
                  <Text style={s.emptyTitle}>Couldn't fetch results</Text>
                  <TouchableOpacity onPress={() => fetchSearch(searchQuery)} activeOpacity={0.7}>
                    <Text style={s.retryText}>Tap to retry</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Saved addresses */}
              {showIdle && SAVED_ADDRESSES.map((addr, idx) => (
                <React.Fragment key={addr.id}>
                  {idx === 0 && <Text style={s.sectionLabel}>SAVED ADDRESSES</Text>}
                  <TouchableOpacity
                    style={s.savedRow}
                    onPress={() => handleSavedSelect(addr)}
                    activeOpacity={0.7}
                  >
                    <View style={s.savedIconBox}>
                      <View style={[s.resultPinHead, { width: 10, height: 10 }]} />
                      <View style={[s.resultPinTail, { borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7 }]} />
                    </View>
                    <View style={s.savedTextCol}>
                      <View style={s.savedTitleRow}>
                        <Text style={s.savedTitle}>{addr.title}</Text>
                        <View style={s.tagPill}><Text style={s.tagText}>{addr.tag}</Text></View>
                      </View>
                      <Text style={s.savedSubtitle} numberOfLines={1}>{addr.subtitle}</Text>
                    </View>
                  </TouchableOpacity>
                  {idx < SAVED_ADDRESSES.length - 1 && <View style={s.rowDivider} />}
                </React.Fragment>
              ))}
            </ScrollView>
          )}

        </Animated.View>
      </View>
    </Modal>
  );
}

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

  // Drag handle
  dragArea: { alignItems: 'center', paddingVertical: 10 },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.border,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingBottom: 14,
    gap: 10,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontFamily: FontFamily.medium,
  },
  headerTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.md,
    color: Colors.text,
    letterSpacing: -0.2,
  },
  headerDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: Spacing.base,
    marginBottom: 14,
  },

  // Search bar
  searchWrap: { paddingHorizontal: Spacing.base, marginBottom: 12 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.md,
    height: 48,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchBarConfirmed: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryBg,
  },
  searchIconPlaceholder: { width: 20 },
  searchIconBox: { width: 18, height: 18 },
  searchCircle: {
    width: 12,
    height: 12,
    borderRadius: Radius.full,
    borderWidth: 2,
    borderColor: Colors.textMuted,
    position: 'absolute',
    top: 0,
    left: 0,
  },
  searchHandle: {
    width: 6,
    height: 2,
    backgroundColor: Colors.textMuted,
    position: 'absolute',
    bottom: 1,
    right: 0,
    transform: [{ rotate: '45deg' }],
    borderRadius: 1,
  },
  searchInput: {
    flex: 1,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.text,
    paddingVertical: 0,
  },
  clearBtn: {
    width: 20,
    height: 20,
    borderRadius: Radius.full,
    backgroundColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearBtnText: {
    fontSize: 9,
    color: Colors.textSecondary,
    fontFamily: FontFamily.bold,
  },

  // Map preview
  mapWrap: {
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
    borderRadius: Radius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  map: { height: 160, width: '100%' },
  mapAddressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.white,
  },
  mapPinDot: {
    width: 8,
    height: 8,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
    marginTop: 4,
    flexShrink: 0,
  },
  mapAddressText: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.text,
    lineHeight: 18,
  },
  mapActions: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    backgroundColor: Colors.white,
  },
  changeBtn: {
    flex: 1,
    height: 44,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  changeBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  confirmBtn: {
    flex: 2,
    height: 44,
    borderRadius: Radius.xl,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.sm,
  },
  confirmBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.white,
    letterSpacing: 0.2,
  },

  // Primary actions
  primaryActions: {
    marginHorizontal: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 16,
    overflow: 'hidden',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 13,
    gap: 12,
  },
  actionDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginLeft: Spacing.md + 40 + 12,
  },
  actionIconBox: {
    width: 40,
    height: 40,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gpsOuter: {
    width: 20,
    height: 20,
    borderRadius: Radius.full,
    borderWidth: 2,
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gpsInner: {
    width: 7,
    height: 7,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
  },
  addText: {
    fontFamily: FontFamily.bold,
    fontSize: 22,
    color: Colors.success,
    lineHeight: 26,
    marginTop: -1,
  },
  actionTextCol: { flex: 1 },
  actionTitle: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.text,
  },
  actionError: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.danger,
    marginTop: 2,
  },

  // Scroll area
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.base, paddingBottom: Spacing.base },

  // Search results
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    gap: 12,
  },
  resultIconBox: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultPinHead: {
    width: 12,
    height: 12,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
    marginBottom: -2,
  },
  resultPinTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: Colors.primary,
  },
  resultTextCol: { flex: 1 },
  resultPrimary: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.text,
    marginBottom: 2,
  },
  resultSecondary: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  rowDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginLeft: 36 + 12,
  },

  // Saved addresses
  sectionLabel: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    letterSpacing: 0.6,
    marginBottom: 8,
    marginTop: 4,
  },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    gap: 12,
  },
  savedIconBox: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedTextCol: { flex: 1 },
  savedTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  savedTitle: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.text,
  },
  tagPill: {
    backgroundColor: Colors.primaryBg,
    borderRadius: Radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tagText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xs,
    color: Colors.primary,
  },
  savedSubtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Empty / error states
  emptyState: {
    alignItems: 'center',
    paddingVertical: Spacing['2xl'],
    gap: Spacing.sm,
  },
  emptyEmoji: { fontSize: 36, marginBottom: 4 },
  emptyTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
  },
  emptySubtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  retryText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.primary,
    textDecorationLine: 'underline',
    marginTop: 4,
  },
});
