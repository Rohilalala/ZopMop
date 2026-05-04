import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  
  TextInput,
  FlatList,
  Platform,
  KeyboardAvoidingView,
  Animated,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types/navigation';
import {
  checkServiceability,
  findCityByName,
  ALL_KNOWN_CITIES,
} from '../../utils/serviceability';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Location'>;
};

type Mode = 'choose' | 'gps' | 'manual';
type GpsState = 'idle' | 'requesting' | 'checking' | 'denied' | 'error';

export default function LocationCheckScreen({ navigation }: Props) {
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [mode, setMode] = useState<Mode>('choose');
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const [searchQuery, setSearchQuery] = useState('');

  const rippleScale = useRef(new Animated.Value(1)).current;
  const rippleOpacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(rippleScale, { toValue: 1.4, duration: 1600, useNativeDriver: true }),
          Animated.timing(rippleOpacity, { toValue: 0, duration: 1600, useNativeDriver: true }),
        ]),
        Animated.delay(400),
        Animated.parallel([
          Animated.timing(rippleScale, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(rippleOpacity, { toValue: 0.3, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  // Filtered city list based on search input
  const filteredCities = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return ALL_KNOWN_CITIES;
    return ALL_KNOWN_CITIES.filter((c) =>
      c.displayName.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  // --- GPS flow ---
  async function handleGps() {
    setMode('gps');
    setGpsState('requesting');

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        setGpsState('denied');
        return;
      }

      setGpsState('checking');
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const { latitude, longitude } = pos.coords;
        const city = checkServiceability(latitude, longitude);

        if (city) {
          navigation.replace('PhoneEntry');
        } else {
          let cityName = 'your city';
          try {
            const [geo] = await Location.reverseGeocodeAsync({ latitude, longitude });
            cityName = geo.city || geo.region || geo.subregion || 'your city';
          } catch { /* use fallback */ }
          navigation.replace('NotServiceable', { cityName });
        }
      } catch {
        setGpsState('error');
      }
    } catch {
      setGpsState('denied');
    }
  }

  // --- Manual city selection ---
  function handleCitySelect(cityDisplayName: string) {
    const matched = findCityByName(cityDisplayName);
    if (matched) {
      navigation.replace('PhoneEntry');
    } else {
      navigation.replace('NotServiceable', { cityName: cityDisplayName });
    }
  }

  const isGpsLoading = gpsState === 'requesting' || gpsState === 'checking';

  // ── Choose mode screen ──────────────────────────────────────────────────
  if (mode === 'choose') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.container}>
          {/* Illustration */}
          <View style={styles.illustrationWrapper}>
            <View style={styles.outerRing}>
              <View style={styles.innerCircle}>
                <View style={styles.pinHead}><View style={styles.pinDot} /></View>
                <View style={styles.pinTail} />
              </View>
            </View>
            <Animated.View style={[styles.ripple, styles.ripple1, { transform: [{ scale: rippleScale }], opacity: rippleOpacity }]} />
            <View style={[styles.ripple, styles.ripple2]} />
          </View>

          <View style={styles.copyWrapper}>
            <Text style={styles.heading}>Where are you located?</Text>
            <Text style={styles.subheading}>
              We'll check if ZopMop is available in your area.
            </Text>
          </View>

          <View style={styles.optionsWrapper}>
            {/* GPS option */}
            <TouchableOpacity
              style={styles.optionCard}
              onPress={handleGps}
              activeOpacity={0.8}
            >
              <View style={[styles.optionIcon, { backgroundColor: c.primaryBg }]}>
                {/* GPS crosshair */}
                <View style={styles.crosshairOuter}>
                  <View style={styles.crosshairInner} />
                </View>
              </View>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>Use my current location</Text>
                <Text style={styles.optionDesc}>Automatically detect via GPS</Text>
              </View>
              <View style={styles.chevron} />
            </TouchableOpacity>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Manual option */}
            <TouchableOpacity
              style={styles.optionCard}
              onPress={() => setMode('manual')}
              activeOpacity={0.8}
            >
              <View style={[styles.optionIcon, { backgroundColor: '#F0FDF4' }]}>
                {/* List/search icon suggestion */}
                <View style={styles.listIcon}>
                  <View style={styles.listLine} />
                  <View style={[styles.listLine, { width: 16 }]} />
                  <View style={styles.listLine} />
                </View>
              </View>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>Enter city manually</Text>
                <Text style={styles.optionDesc}>Search and select your city</Text>
              </View>
              <View style={styles.chevron} />
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── GPS flow screen ──────────────────────────────────────────────────────
  if (mode === 'gps') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.container}>
          <View style={styles.illustrationWrapper}>
            <View style={styles.outerRing}>
              <View style={styles.innerCircle}>
                <View style={styles.pinHead}><View style={styles.pinDot} /></View>
                <View style={styles.pinTail} />
              </View>
            </View>
            <Animated.View style={[styles.ripple, styles.ripple1, { transform: [{ scale: rippleScale }], opacity: rippleOpacity }]} />
            <View style={[styles.ripple, styles.ripple2]} />
          </View>

          <View style={styles.copyWrapper}>
            <Text style={styles.heading}>Allow location access</Text>
            <Text style={styles.subheading}>
              ZopMop uses your location to check service availability and connect you with nearby helpers.
            </Text>
          </View>

          {gpsState === 'denied' && (
            <View style={styles.deniedCard}>
              <Text style={styles.deniedTitle}>Location access needed</Text>
              <Text style={styles.deniedText}>
                Please enable location from{' '}
                {Platform.OS === 'ios'
                  ? 'Settings → Privacy → Location'
                  : 'Settings → App Permissions'}{' '}
                and try again.
              </Text>
            </View>
          )}
          {gpsState === 'error' && (
            <View style={styles.deniedCard}>
              <Text style={styles.deniedTitle}>Couldn't get your location</Text>
              <Text style={styles.deniedText}>
                Make sure GPS is on and you have a signal, then try again. You can also enter your city manually.
              </Text>
            </View>
          )}
        </View>

        <View style={styles.bottomActions}>
          <TouchableOpacity
            style={[styles.primaryButton, isGpsLoading && styles.buttonLoading]}
            onPress={handleGps}
            disabled={isGpsLoading}
            activeOpacity={0.85}
          >
            {isGpsLoading ? (
              <LoadingBars color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.primaryButtonText}>
                {gpsState === 'denied' || gpsState === 'error' ? 'Try again' : 'Allow location access'}
              </Text>
            )}
          </TouchableOpacity>

          <Text style={styles.statusHint}>
            {gpsState === 'checking' ? 'Checking service availability…' : ' '}
          </Text>

          <TouchableOpacity onPress={() => setMode('manual')} activeOpacity={0.7}>
            <Text style={styles.switchLink}>Enter city manually instead</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Manual city picker screen ────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.manualHeader}>
          <TouchableOpacity
            onPress={() => { setSearchQuery(''); setMode('choose'); }}
            style={styles.backButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <View style={styles.backArrow} />
          </TouchableOpacity>
          <Text style={styles.manualTitle}>Select your city</Text>
        </View>

        {/* Search */}
        <View style={styles.searchWrapper}>
          <View style={styles.searchBar}>
            <View style={styles.searchIcon}>
              <View style={styles.searchCircle} />
              <View style={styles.searchHandle} />
            </View>
            <TextInput
              style={styles.searchInput}
              placeholder="Search city…"
              placeholderTextColor={c.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
              autoCapitalize="words"
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <View style={styles.clearDot} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* City list */}
        <FlatList
          data={filteredCities}
          keyExtractor={(item) => item.displayName}
          contentContainerStyle={styles.cityList}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.cityRow}
              onPress={() => handleCitySelect(item.displayName)}
              activeOpacity={0.7}
            >
              <View style={styles.cityRowLeft}>
                <Text style={styles.cityName}>{item.displayName}</Text>
                {item.serviceable && (
                  <View style={styles.availablePill}>
                    <Text style={styles.availablePillText}>Available</Text>
                  </View>
                )}
              </View>
              {!item.serviceable && (
                <Text style={styles.comingSoon}>Coming soon</Text>
              )}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No cities found for "{searchQuery}"</Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />

        {/* Switch to GPS */}
        <View style={styles.gpsLinkWrapper}>
          <TouchableOpacity onPress={() => { setSearchQuery(''); setMode('gps'); handleGps(); }} activeOpacity={0.7}>
            <Text style={styles.switchLink}>Use my GPS location instead</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing['2xl'] },
    illustrationWrapper: { width: 160, height: 160, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing['2xl'], position: 'relative' },
    outerRing: { width: 96, height: 96, borderRadius: Radius.full, backgroundColor: c.primaryBg, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
    innerCircle: { alignItems: 'center', justifyContent: 'flex-end', height: 52 },
    pinHead: { width: 32, height: 32, borderRadius: Radius.full, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
    pinDot: { width: 10, height: 10, borderRadius: Radius.full, backgroundColor: '#FFFFFF' },
    pinTail: { width: 0, height: 0, borderLeftWidth: 8, borderRightWidth: 8, borderTopWidth: 14, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: c.primary, marginTop: -2 },
    ripple: { position: 'absolute', borderRadius: Radius.full, borderWidth: 1.5, borderColor: c.primary, zIndex: 1 },
    ripple1: { width: 120, height: 120, opacity: 0.25 },
    ripple2: { width: 156, height: 156, opacity: 0.1 },
    copyWrapper: { alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.md, marginBottom: Spacing['2xl'] },
    heading: { fontFamily: FontFamily.bold, fontSize: FontSize['2xl'], color: c.text, textAlign: 'center', letterSpacing: -0.3 },
    subheading: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textSecondary, textAlign: 'center', lineHeight: FontSize.base * 1.6 },
    optionsWrapper: { width: '100%', gap: Spacing.md },
    optionCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.white, borderRadius: Radius.xl, padding: Spacing.base, gap: Spacing.md, ...Shadow.sm },
    optionIcon: { width: 48, height: 48, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center' },
    optionText: { flex: 1, gap: 2 },
    optionTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: c.text },
    optionDesc: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary },
    chevron: { width: 8, height: 8, borderTopWidth: 2, borderRightWidth: 2, borderColor: c.textMuted, transform: [{ rotate: '45deg' }], marginRight: Spacing.xs },
    dividerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginVertical: Spacing.xs },
    dividerLine: { flex: 1, height: 1, backgroundColor: c.border },
    dividerText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted },
    crosshairOuter: { width: 24, height: 24, borderRadius: Radius.full, borderWidth: 2, borderColor: c.primary, alignItems: 'center', justifyContent: 'center' },
    crosshairInner: { width: 8, height: 8, borderRadius: Radius.full, backgroundColor: c.primary },
    listIcon: { gap: 4, alignItems: 'flex-start' },
    listLine: { width: 20, height: 2, backgroundColor: c.success, borderRadius: 1 },
    bottomActions: { paddingHorizontal: Spacing['2xl'], paddingBottom: Spacing['2xl'], alignItems: 'center', gap: Spacing.sm },
    primaryButton: { width: '100%', height: 52, backgroundColor: c.primary, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center', ...Shadow.md },
    buttonLoading: { opacity: 0.8 },
    primaryButtonText: { fontFamily: FontFamily.semibold, fontSize: FontSize.md, color: '#FFFFFF', letterSpacing: 0.1 },
    statusHint: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted, height: 18 },
    switchLink: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.primary, textDecorationLine: 'underline' },
    deniedCard: { marginTop: Spacing.xl, backgroundColor: c.dangerBg, borderRadius: Radius.lg, padding: Spacing.base, width: '100%', gap: Spacing.xs },
    deniedTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.danger },
    deniedText: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.danger, lineHeight: FontSize.sm * 1.6 },
    manualHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.base, paddingVertical: Spacing.md, gap: Spacing.md },
    backButton: { width: 36, height: 36, borderRadius: Radius.md, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
    backArrow: { width: 8, height: 8, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: c.text, transform: [{ rotate: '45deg' }], marginLeft: 4 },
    manualTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text },
    searchWrapper: { paddingHorizontal: Spacing.base, paddingBottom: Spacing.sm },
    searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.white, borderRadius: Radius.xl, paddingHorizontal: Spacing.md, height: 48, gap: Spacing.sm, ...Shadow.sm },
    searchIcon: { position: 'relative', width: 18, height: 18 },
    searchCircle: { width: 12, height: 12, borderRadius: Radius.full, borderWidth: 2, borderColor: c.textMuted, position: 'absolute', top: 0, left: 0 },
    searchHandle: { width: 6, height: 2, backgroundColor: c.textMuted, position: 'absolute', bottom: 0, right: 0, transform: [{ rotate: '45deg' }], borderRadius: 1 },
    searchInput: { flex: 1, fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.text, paddingVertical: 0 },
    clearDot: { width: 16, height: 16, borderRadius: Radius.full, backgroundColor: c.border },
    cityList: { paddingHorizontal: Spacing.base, paddingBottom: Spacing.base },
    cityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.md },
    cityRowLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
    cityName: { fontFamily: FontFamily.medium, fontSize: FontSize.md, color: c.text },
    availablePill: { backgroundColor: c.successBg, borderRadius: Radius.full, paddingHorizontal: Spacing.sm, paddingVertical: 2 },
    availablePillText: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs, color: c.success },
    comingSoon: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted },
    separator: { height: 1, backgroundColor: c.border },
    emptyState: { paddingTop: Spacing['3xl'], alignItems: 'center' },
    emptyText: { fontFamily: FontFamily.regular, fontSize: FontSize.base, color: c.textMuted, textAlign: 'center' },
    gpsLinkWrapper: { alignItems: 'center', paddingVertical: Spacing.lg, borderTopWidth: 1, borderTopColor: c.border },
  });
}
