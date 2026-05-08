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
  Easing,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import Feather from '@expo/vector-icons/Feather';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import {
  checkServiceability,
  findCityByName,
  ALL_KNOWN_CITIES,
} from '../../utils/serviceability';
import { GlassCard } from '../../components/home/GlassCard';
import { FontFamily, FontSize, Spacing, Radius } from '../../theme';

// Hard-coded dark + amber palette to match the locked home aesthetic
// (memory: dark home pattern, light mode deferred). Auth screens that fall
// after sign-in step into the same visual language as Home.
const BG = '#0A0A0A';
const SURFACE_DEEP = '#0D0D0F';
const TEXT_HI = '#FFFFFF';
const TEXT_MID = 'rgba(255,255,255,0.62)';
const TEXT_DIM = 'rgba(255,255,255,0.38)';
const HAIRLINE = 'rgba(255,255,255,0.08)';
const AMBER = '#F5A300';
const AMBER_HI = '#FFC042';
const AMBER_TINT_12 = 'rgba(245,163,0,0.12)';
const AMBER_TINT_18 = 'rgba(245,163,0,0.18)';
const DANGER = '#F87171';
const DANGER_TINT = 'rgba(248,113,113,0.12)';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Location'>;
  route: RouteProp<AuthStackParamList, 'Location'>;
};

type Mode = 'choose' | 'gps' | 'manual';
type GpsState = 'idle' | 'requesting' | 'checking' | 'denied' | 'error';

export default function LocationCheckScreen({ navigation, route }: Props) {
  const { phone, name } = route.params;
  const styles = useMemo(() => createStyles(), []);
  const [mode, setMode] = useState<Mode>('choose');
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const [searchQuery, setSearchQuery] = useState('');

  const fade = useRef(new Animated.Value(0)).current;
  const rippleScale = useRef(new Animated.Value(1)).current;
  const rippleOpacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 480,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [fade]);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(rippleScale, { toValue: 1.55, duration: 1900, useNativeDriver: true }),
          Animated.timing(rippleOpacity, { toValue: 0, duration: 1900, useNativeDriver: true }),
        ]),
        Animated.delay(300),
        Animated.parallel([
          Animated.timing(rippleScale, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(rippleOpacity, { toValue: 0.5, duration: 0, useNativeDriver: true }),
        ]),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [rippleScale, rippleOpacity]);

  const filteredCities = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return ALL_KNOWN_CITIES;
    return ALL_KNOWN_CITIES.filter((city) =>
      city.displayName.toLowerCase().includes(q),
    );
  }, [searchQuery]);

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
          navigation.replace('Welcome', { phone, name });
        } else {
          let cityName = 'your city';
          try {
            const [geo] = await Location.reverseGeocodeAsync({ latitude, longitude });
            cityName = geo.city || geo.region || geo.subregion || 'your city';
          } catch { /* fallback */ }
          navigation.replace('NotServiceable', { cityName, phone, name });
        }
      } catch {
        setGpsState('error');
      }
    } catch {
      setGpsState('denied');
    }
  }

  function handleCitySelect(cityDisplayName: string) {
    const matched = findCityByName(cityDisplayName);
    if (matched) {
      navigation.replace('Welcome', { phone, name });
    } else {
      navigation.replace('NotServiceable', { cityName: cityDisplayName, phone, name });
    }
  }

  const isGpsLoading = gpsState === 'requesting' || gpsState === 'checking';

  function PinIllustration({ icon = 'map-pin' }: { icon?: 'map-pin' | 'navigation' }) {
    return (
      <View style={styles.illustrationWrap}>
        <Animated.View
          style={[
            styles.ripple,
            styles.rippleOuter,
            { transform: [{ scale: rippleScale }], opacity: rippleOpacity },
          ]}
        />
        <View style={[styles.ripple, styles.rippleMid]} />
        <View style={styles.pinCircle}>
          <View style={styles.pinInner}>
            <Feather name={icon} size={32} color={AMBER} />
          </View>
        </View>
      </View>
    );
  }

  // ── Choose mode ─────────────────────────────────────────────────────────
  if (mode === 'choose') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <Animated.View style={[styles.flex, { opacity: fade }]}>
          <View style={styles.topSpacer} />

          <PinIllustration />

          <View style={styles.copy}>
            <Text style={styles.title}>Where are you located?</Text>
            <Text style={styles.subtitle}>
              We'll check if <Text style={styles.zopBrand}>Zop</Text>
              <Text style={styles.mopBrand}>Mop</Text> is available in your area.
            </Text>
          </View>

          <View style={styles.bottomSpacer} />

          <View style={styles.options}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={handleGps}
            >
              <GlassCard radius={Radius.xl} style={styles.optionCard}>
                <View style={styles.optionIconAmber}>
                  <Feather name="navigation" size={20} color={AMBER} />
                </View>
                <View style={styles.optionText}>
                  <Text style={styles.optionTitle}>Use my current location</Text>
                  <Text style={styles.optionDesc}>Detect via GPS</Text>
                </View>
                <Feather name="chevron-right" size={20} color={TEXT_DIM} />
              </GlassCard>
            </TouchableOpacity>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => setMode('manual')}
            >
              <GlassCard radius={Radius.xl} style={styles.optionCard}>
                <View style={styles.optionIconNeutral}>
                  <Feather name="search" size={20} color={TEXT_HI} />
                </View>
                <View style={styles.optionText}>
                  <Text style={styles.optionTitle}>Enter city manually</Text>
                  <Text style={styles.optionDesc}>Search and select</Text>
                </View>
                <Feather name="chevron-right" size={20} color={TEXT_DIM} />
              </GlassCard>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── GPS request / status ────────────────────────────────────────────────
  if (mode === 'gps') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <Animated.View style={[styles.flex, { opacity: fade }]}>
          <View style={styles.topSpacer} />

          <PinIllustration icon="navigation" />

          <View style={styles.copy}>
            <Text style={styles.title}>Allow location access</Text>
            <Text style={styles.subtitle}>
              <Text style={styles.zopBrand}>Zop</Text>
              <Text style={styles.mopBrand}>Mop</Text> uses your location to check
              service availability and connect you with nearby helpers.
            </Text>
          </View>

          {gpsState === 'denied' && (
            <View style={styles.alertCard}>
              <Feather name="alert-triangle" size={16} color={DANGER} />
              <View style={styles.alertText}>
                <Text style={styles.alertTitle}>Location access needed</Text>
                <Text style={styles.alertBody}>
                  Enable location from{' '}
                  {Platform.OS === 'ios'
                    ? 'Settings → Privacy → Location'
                    : 'Settings → App Permissions'}{' '}
                  and try again.
                </Text>
              </View>
            </View>
          )}
          {gpsState === 'error' && (
            <View style={styles.alertCard}>
              <Feather name="alert-circle" size={16} color={DANGER} />
              <View style={styles.alertText}>
                <Text style={styles.alertTitle}>Couldn't get your location</Text>
                <Text style={styles.alertBody}>
                  Make sure GPS is on, then try again. You can also enter your
                  city manually.
                </Text>
              </View>
            </View>
          )}

          <View style={styles.bottomSpacer} />
        </Animated.View>

        <View style={styles.bottom}>
          <TouchableOpacity
            style={[styles.primaryButton, isGpsLoading && styles.primaryButtonLoading]}
            onPress={handleGps}
            disabled={isGpsLoading}
            activeOpacity={0.9}
          >
            {isGpsLoading ? (
              <LoadingBars color={SURFACE_DEEP} size="small" />
            ) : (
              <Text style={styles.primaryButtonText}>
                {gpsState === 'denied' || gpsState === 'error'
                  ? 'Try again'
                  : 'Allow location access'}
              </Text>
            )}
          </TouchableOpacity>

          <Text style={styles.statusHint}>
            {gpsState === 'checking' ? 'Checking service availability…' : ' '}
          </Text>

          <TouchableOpacity onPress={() => setMode('manual')} activeOpacity={0.7}>
            <Text style={styles.linkText}>Enter city manually instead</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Manual city picker ──────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.manualHeader}>
          <TouchableOpacity
            onPress={() => { setSearchQuery(''); setMode('choose'); }}
            style={styles.backButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.8}
          >
            <Feather name="arrow-left" size={20} color={TEXT_HI} />
          </TouchableOpacity>
          <Text style={styles.manualTitle}>Select your city</Text>
        </View>

        <View style={styles.searchWrapper}>
          <GlassCard radius={Radius.xl} style={styles.searchBar}>
            <Feather name="search" size={18} color={TEXT_DIM} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search city…"
              placeholderTextColor={TEXT_DIM}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
              autoCapitalize="words"
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => setSearchQuery('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="x-circle" size={18} color={TEXT_DIM} />
              </TouchableOpacity>
            )}
          </GlassCard>
        </View>

        <FlatList
          data={filteredCities}
          keyExtractor={(item) => item.displayName}
          contentContainerStyle={styles.cityList}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.cityRow}
              onPress={() => handleCitySelect(item.displayName)}
              activeOpacity={0.6}
            >
              <View style={styles.cityRowLeft}>
                <Feather
                  name="map-pin"
                  size={16}
                  color={item.serviceable ? AMBER : TEXT_DIM}
                />
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
              <Feather name="search" size={28} color={TEXT_DIM} />
              <Text style={styles.emptyText}>No cities found for "{searchQuery}"</Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />

        <View style={styles.gpsLinkWrapper}>
          <TouchableOpacity
            onPress={() => { setSearchQuery(''); setMode('gps'); handleGps(); }}
            activeOpacity={0.7}
          >
            <Text style={styles.linkText}>Use my GPS location instead</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function createStyles() {
  return StyleSheet.create({
    flex: { flex: 1 },
    safe: { flex: 1, backgroundColor: BG },
    topSpacer: { flex: 0.6 },
    bottomSpacer: { flex: 0.5 },

    // Illustration
    illustrationWrap: {
      width: 160,
      height: 160,
      alignSelf: 'center',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    ripple: {
      position: 'absolute',
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: AMBER,
    },
    rippleOuter: { width: 132, height: 132 },
    rippleMid: { width: 158, height: 158, opacity: 0.15 },
    pinCircle: {
      width: 92,
      height: 92,
      borderRadius: Radius.full,
      backgroundColor: AMBER_TINT_12,
      borderWidth: 1,
      borderColor: AMBER_TINT_18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pinInner: {
      width: 64,
      height: 64,
      borderRadius: Radius.full,
      backgroundColor: AMBER_TINT_18,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Copy
    copy: {
      paddingHorizontal: 24,
      alignItems: 'center',
      gap: 10,
      marginTop: Spacing['2xl'],
    },
    title: {
      fontFamily: FontFamily.extrabold,
      fontSize: 30,
      lineHeight: 36,
      letterSpacing: -0.6,
      color: TEXT_HI,
      textAlign: 'center',
    },
    subtitle: {
      fontFamily: FontFamily.regular,
      fontSize: 15,
      lineHeight: 22,
      color: TEXT_MID,
      textAlign: 'center',
      paddingHorizontal: Spacing.md,
    },
    zopBrand: { fontFamily: FontFamily.extrabold, color: AMBER_HI },
    mopBrand: { fontFamily: FontFamily.extrabold, color: TEXT_HI },

    // Options
    options: {
      paddingHorizontal: 24,
      paddingBottom: Spacing['2xl'],
      gap: Spacing.md,
    },
    optionCard: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.base,
      gap: Spacing.md,
    },
    optionIconAmber: {
      width: 44,
      height: 44,
      borderRadius: Radius.lg,
      backgroundColor: AMBER_TINT_12,
      borderWidth: 1,
      borderColor: AMBER_TINT_18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optionIconNeutral: {
      width: 44,
      height: 44,
      borderRadius: Radius.lg,
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderWidth: 1,
      borderColor: HAIRLINE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optionText: { flex: 1, gap: 2 },
    optionTitle: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.md,
      color: TEXT_HI,
      letterSpacing: -0.2,
    },
    optionDesc: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: TEXT_MID,
    },
    dividerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.md,
      paddingVertical: Spacing.xs,
    },
    dividerLine: { flex: 1, height: 1, backgroundColor: HAIRLINE },
    dividerText: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: TEXT_DIM,
    },

    // Alerts (GPS denied / error)
    alertCard: {
      flexDirection: 'row',
      gap: Spacing.sm,
      marginHorizontal: 24,
      marginTop: Spacing.xl,
      backgroundColor: DANGER_TINT,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: 'rgba(248,113,113,0.22)',
      padding: Spacing.base,
    },
    alertText: { flex: 1, gap: 2 },
    alertTitle: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: DANGER },
    alertBody: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: 'rgba(248,113,113,0.85)',
      lineHeight: FontSize.sm * 1.6,
    },

    // Bottom CTA (amber, dark text — matches home button)
    bottom: {
      paddingHorizontal: 24,
      paddingBottom: 20,
      gap: Spacing.sm,
      alignItems: 'center',
    },
    primaryButton: {
      width: '100%',
      height: 54,
      backgroundColor: AMBER,
      borderRadius: Radius.xl,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: AMBER,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.35,
      shadowRadius: 18,
      elevation: 10,
    },
    primaryButtonLoading: { opacity: 0.85 },
    primaryButtonText: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize.md,
      color: SURFACE_DEEP,
      letterSpacing: 0.2,
    },
    statusHint: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: TEXT_DIM,
      height: 18,
    },
    linkText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: AMBER_HI,
    },

    // Manual mode
    manualHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.base,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.md,
      gap: Spacing.md,
    },
    backButton: {
      width: 40,
      height: 40,
      borderRadius: Radius.md,
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderWidth: 1,
      borderColor: HAIRLINE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    manualTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.lg,
      color: TEXT_HI,
      letterSpacing: -0.3,
    },
    searchWrapper: { paddingHorizontal: Spacing.base, paddingBottom: Spacing.sm },
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.base,
      height: 52,
      gap: Spacing.sm,
    },
    searchInput: {
      flex: 1,
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: TEXT_HI,
      paddingVertical: 0,
    },
    cityList: { paddingHorizontal: Spacing.base, paddingBottom: Spacing.base },
    cityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: Spacing.md,
    },
    cityRowLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
    cityName: { fontFamily: FontFamily.medium, fontSize: FontSize.md, color: TEXT_HI },
    availablePill: {
      backgroundColor: AMBER_TINT_18,
      borderRadius: Radius.full,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 2,
      borderWidth: 1,
      borderColor: AMBER_TINT_18,
    },
    availablePillText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.xs,
      color: AMBER_HI,
    },
    comingSoon: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: TEXT_DIM },
    separator: { height: 1, backgroundColor: HAIRLINE },
    emptyState: { paddingTop: Spacing['3xl'], alignItems: 'center', gap: Spacing.md },
    emptyText: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: TEXT_DIM,
      textAlign: 'center',
    },
    gpsLinkWrapper: {
      alignItems: 'center',
      paddingVertical: Spacing.lg,
      borderTopWidth: 1,
      borderTopColor: HAIRLINE,
    },
  });
}
