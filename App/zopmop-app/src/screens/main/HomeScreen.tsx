// HomeScreen — thin SDUI renderer.
//
// This screen used to be a several-hundred-line monolith that hardcoded the
// layout: hero carousel slides, popular services list, live pill, etc. All
// of that is now driven by the BFF (`GET /page/home`) and a section registry.
//
// What stays here (app-shell, not section data):
//   - Location resolution (expo-location, address picker, serviceability).
//   - HomeHeader (the location chip + cart button).
//   - LocationSelectorModal (overlay).
//   - HomeCartBar (sticky bottom bar).
//   - UpcomingBookingIndicator (status pill).
//   - NotServiceableScreen (when geocoded coords are out of zone).
//
// What moved into SDUI sections:
//   - HeroCarousel slides (promos + greeting)
//   - LivePill nearby stats
//   - UsualsRow service shortcuts
//   - PopularServices grid
//   - HomeFooter
//
// Parallax was removed: FlashList virtualises rows, so the previous
// `Animated.ScrollView + interpolate(scrollY)` pattern would require a
// custom scroll handler with momentum forwarding. The simpler renderer is
// a better default; we can re-introduce parallax via a header section if
// product wants it back.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Location from 'expo-location';
import { FlashList } from '@shopify/flash-list';
import Constants from 'expo-constants';

import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { checkServiceability } from '../../api/zones';
import { listAddresses } from '../../api/addresses';
import { apiFetch } from '../../api/client';

import { LocationSelector } from '../../components/LocationSelector';
import UpcomingBookingIndicator from '../../components/UpcomingBookingIndicator';
import { HomeHeader } from '../../components/home/HomeHeader';
import { HomeHero } from '../../components/home/HomeHero';
import { HomeCartBar } from '../../components/home/HomeCartBar';
import { Bloom } from '../../components/home/Bloom';
import { useTheme } from '../../context/ThemeContext';
import { useC } from '../../theme/screen';
import NotServiceableScreen from './NotServiceableScreen';
import { HomeScreenSkeleton } from '../../components/skeletons/HomeScreenSkeleton';
import { partitionHomeSections } from './homeSections';

import { useSduiPage } from '../../hooks/useSduiPage';
import { SectionRenderer } from '../../sdui/SectionRenderer';
import { HeroPager } from '../../components/home/HeroPager';
import { SduiErrorBoundary } from '../../components/SduiErrorBoundary';
import { executeAction } from '../../sdui/ActionHandler';
import { setAnalyticsContext } from '../../analytics/context';
import { showError, showSuccess, showInfo } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import { usePostHog } from 'posthog-react-native';
import { usePrefetch } from '../../context/PrefetchContext';
import { writeLastKnownLocation, readLastKnownLocation } from '../../utils/locationCache';
import type { SduiAction, SduiSection } from '../../sdui/types';
import {
  Easing,
  cancelAnimation,
  runOnJS,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

// Last-resort coordinates — only used after the user denies location *and*
// has no cached last-known location. We surface a "Set your address" prompt
// alongside this fallback so the user understands services may not be
// nearby. Tied to current launch city (Gurugram).
const DEFAULT_LAT = 28.4357;
const DEFAULT_LON = 77.0763;

const { width: SCREEN_W } = Dimensions.get('window');

export default function HomeScreen() {
  const { isDark, colors: themeColors } = useTheme();
  const sc = useC();
  const { token, user } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const insets = useSafeAreaInsets();
  const { consumeHome } = usePrefetch();
  const posthog = usePostHog();

  // Read prefetched data once on mount. Already-fetched SDUI page + coords
  // become initial state, so first paint is instant when prefetch completed.
  const prefetchedRef = useRef(consumeHome());
  const prefetched = prefetchedRef.current;

  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const [locationName, setLocationName] = useState('Detecting location…');
  const [selectedAddressId, setSelectedAddressId] = useState<string | undefined>();
  const [addressTag, setAddressTag] = useState<string | undefined>();
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(prefetched?.coords ?? null);
  const [serviceable, setServiceable] = useState(true);
  const [bootstrapping, setBootstrapping] = useState(prefetched?.page == null);

  // ── SDUI page fetch (driven by resolved coords) ───────────────────────────
  const { page, loading, fetchSection, refetch } = useSduiPage(
    'home',
    {
      lat: coords?.lat,
      lon: coords?.lon,
      initialPage: prefetched?.page ?? null,
    },
  );

  // ── Pull-to-refresh easter egg ────────────────────────────────────────────
  // Choreography (driven by RefreshControl trigger):
  //   1. eyes fade out         (180ms)
  //   2. fly up to mid-screen + spin 720°  (650ms, ease-out)
  //   3. hold mid-screen       (200ms)
  //   4. spring back home + rotation lands at 0  (~600ms spring)
  //   5. eyes fade in          (180ms)
  //   6. wink (right eye → flat line → open) (180+220ms)
  //
  // All driven from shared values so it runs on the UI thread (60fps).
  const [refreshing, setRefreshing] = useState(false);
  const [heroShowFace, setHeroShowFace] = useState(true);
  const heroTransX  = useSharedValue(0);
  const heroTransY  = useSharedValue(0);
  const heroScale   = useSharedValue(1);
  const heroRotZ    = useSharedValue(0);
  const heroEye     = useSharedValue(1);
  const heroWink    = useSharedValue(0);

  // Land the Zop in the same spot the other-screen ZopRefresh overlay uses:
  // horizontally centred, vertically ABOVE the content (~y=88 in screen
  // coords — matches `top:60` + small Zop centre offset of 28px).
  //
  // Resting Zop centre in screen coords (approx):
  //   y = insets.top + (header 50) + (card margin 14) + (card top:-6) + (130/2)
  //   x = (SCREEN_W - 20)  // card right edge
  //       + (-14)          // Zop right offset past card
  //       - (130/2)        // back to centre
  const zopRestY = insets.top + 64 + 130 / 2 - 6;
  // Card right edge in screen coords = SCREEN_W - 20 (margin). Zop's right
  // offset is -14 (extends past card right by 14). Zop right edge therefore
  // sits at SCREEN_W - 20 + 14 = SCREEN_W - 6. Centre = right - 130/2.
  const zopRestX = SCREEN_W - 6 - 130 / 2;
  const TARGET_TOP = 60 + 56 / 2;          // = 88, matches ZopRefresh.tsx
  const flyTargetX = SCREEN_W / 2 - zopRestX;
  const flyTargetY = TARGET_TOP - zopRestY; // negative — Zop flies UP
  const FLY_SCALE  = 56 / 130;             // matches small loading Zop

  const onRefresh = useCallback(async () => {
    haptics.medium();
    setRefreshing(true);

    // Cancel any in-flight animations so a re-trigger reads cleanly.
    cancelAnimation(heroTransX);
    cancelAnimation(heroTransY);
    cancelAnimation(heroScale);
    cancelAnimation(heroRotZ);
    cancelAnimation(heroEye);
    cancelAnimation(heroWink);

    // Strip the face immediately — body-only Zop while loading. Matches the
    // other-screen ZopRefresh visual.
    setHeroShowFace(false);
    heroEye.value  = 0;
    heroWink.value = 0;

    const FLY_MS  = 700;
    const HOLD_MS = 700;
    // Continuous rotation at ZopRefresh's exact speed: 360° / 1100ms linear.
    heroRotZ.value = 0;
    heroRotZ.value = withRepeat(
      withTiming(360, { duration: 1100, easing: Easing.linear }),
      -1,
      false,
    );

    // Fly to centre + shrink, hold, then spring back home.
    const fly = (to: number) =>
      withSequence(
        withTiming(to, { duration: FLY_MS, easing: Easing.out(Easing.cubic) }),
        withDelay(HOLD_MS, withSpring(0, { damping: 14, stiffness: 160, mass: 0.9 })),
      );

    heroTransX.value = fly(flyTargetX);
    heroTransY.value = fly(flyTargetY);
    heroScale.value  = withSequence(
      withTiming(FLY_SCALE, { duration: FLY_MS, easing: Easing.out(Easing.cubic) }),
      withDelay(HOLD_MS, withSpring(1, { damping: 14, stiffness: 160, mass: 0.9 })),
    );

    // Once Zop is back home (~FLY + HOLD + ~600ms spring), continue rotation
    // FORWARD to the next 90° boundary — the body is 4-fold symmetric so
    // 90° / 180° / 270° / 360° look identical to the resting pose. Avoids
    // the cheap reverse-unwind. The face stays hidden during this short
    // continuation; once Zop has landed, we reset rotation to 0 in the same
    // frame as the face appears so the eyes/mouth read upright.
    const RETURN_AT = FLY_MS + HOLD_MS + 600; // ≈ 2000ms
    setTimeout(() => {
      cancelAnimation(heroRotZ);
      // Zop is back at its original coordinates — let the screen scroll up
      // immediately. The rotation snap + face reveal continue independently
      // (the body keeps spinning a touch as the scroll springs back).
      runOnJS(setRefreshing)(false);

      const current = heroRotZ.value;
      const next = Math.ceil((current + 30) / 90) * 90;
      heroRotZ.value = withTiming(
        next,
        { duration: 220, easing: Easing.out(Easing.cubic) },
        (finished) => {
          if (!finished) return;
          heroRotZ.value = 0;
          runOnJS(setHeroShowFace)(true);
        },
      );
      heroEye.value = withDelay(
        220,
        withTiming(1, { duration: 160, easing: Easing.out(Easing.cubic) }),
      );
    }, RETURN_AT);

    // Wink fires AFTER refreshing flips off — see the useEffect below.

    // Network refresh races in parallel. The choreography flips refreshing
    // off at RETURN_AT (when Zop is back at its origin); this is just a
    // safety net in case refetch hangs.
    try {
      await Promise.race([
        refetch(),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    } finally {
      // No-op — refreshing was already flipped off in the choreography.
    }
  }, [
    refetch, flyTargetX, flyTargetY, FLY_SCALE,
    heroTransX, heroTransY, heroScale, heroRotZ, heroEye, heroWink,
  ]);

  // Wink AFTER the screen has scrolled back up. RefreshControl's spring
  // returns the content to rest ~250ms after `refreshing` flips false.
  const prevRefreshing = useRef(false);
  useEffect(() => {
    if (prevRefreshing.current && !refreshing) {
      const t = setTimeout(() => {
        heroWink.value = withSequence(
          withTiming(1, { duration: 140, easing: Easing.out(Easing.cubic) }),
          withDelay(100, withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) })),
        );
      }, 350);
      prevRefreshing.current = refreshing;
      return () => clearTimeout(t);
    }
    prevRefreshing.current = refreshing;
  }, [refreshing, heroWink]);

  // Set base analytics context once per auth state. config_version is updated
  // whenever a new page payload arrives.
  useEffect(() => {
    setAnalyticsContext({
      user_id:     user?.id ?? 'guest',
      app_version: (Constants?.expoConfig?.version as string | undefined) ?? 'unknown',
      platform:    Platform.OS === 'ios' ? 'ios' : 'android',
    });
  }, [user?.id]);

  useEffect(() => {
    if (!page) return;
    setAnalyticsContext({
      config_version: page.config_version,
      experiment_id:  page.experiment_id ?? null,
    });
  }, [page]);

  // ── Location bootstrap (app-shell, not SDUI) ──────────────────────────────
  //
  // Two-phase resolution so the screen paints immediately:
  //   Phase 1 (instant): read cached last-known location from disk, set coords
  //     and unset `bootstrapping` so the SDUI page (cached or prefetched)
  //     renders. Skeleton dismisses without waiting on GPS.
  //   Phase 2 (background): request permission, try `getLastKnownPositionAsync`
  //     (instant) before falling back to `getCurrentPositionAsync` (GPS warm-up,
  //     can take 2-5s). When precise coords resolve, upgrade coords + name.
  //
  // Address name resolution uses the prefetched address list (see
  // PrefetchContext) instead of re-fetching, avoiding a duplicate round-trip.
  useEffect(() => {
    let cancelled = false;

    const resolveNameFromAddresses = (
      lat: number,
      lon: number,
      saved: NonNullable<typeof prefetched>['addresses'],
    ): string | null => {
      if (!saved || saved.length === 0) return null;
      let nearest = null as null | (typeof saved)[number];
      let minDist = Infinity;
      for (const addr of saved) {
        const d = Math.hypot(addr.lat - lat, addr.lon - lon);
        if (d < minDist) {
          minDist = d;
          nearest = addr;
        }
      }
      const pick =
        nearest && minDist < 0.009
          ? nearest
          : saved.find((a) => a.tag === 'Home') ?? saved[0];
      if (!cancelled) {
        setSelectedAddressId(pick.id);
        setAddressTag(pick.tag ?? undefined);
      }
      return pick.full_address.split(',').slice(0, 2).join(',').trim();
    };

    (async () => {
      // ── Phase 1: paint immediately from cached last-known location ────────
      const cached = await readLastKnownLocation().catch(() => null);
      let lat = cached?.lat ?? prefetched?.coords?.lat ?? DEFAULT_LAT;
      let lon = cached?.lon ?? prefetched?.coords?.lon ?? DEFAULT_LON;
      let name = cached?.name ?? 'Set your address';

      // If we have prefetched addresses, resolve name from them now so the
      // header shows a real address on first paint.
      const savedAddresses = prefetched?.addresses ?? null;
      const fromPrefetch = resolveNameFromAddresses(lat, lon, savedAddresses);
      if (fromPrefetch) name = fromPrefetch;

      if (!cancelled) {
        setLocationName(name);
        setCoords({ lat, lon });
        setBootstrapping(false);
      }

      // ── Phase 2: upgrade location in the background ───────────────────────
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          // Try last-known first (instant), fall back to live GPS only if
          // there's no recent fix cached on-device.
          let pos = await Location.getLastKnownPositionAsync({
            maxAge: 10 * 60 * 1000,
          }).catch(() => null);
          if (!pos) {
            pos = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            }).catch(() => null);
          }
          if (pos && !cancelled) {
            lat = pos.coords.latitude;
            lon = pos.coords.longitude;

            if (savedAddresses && savedAddresses.length > 0) {
              const upgraded = resolveNameFromAddresses(lat, lon, savedAddresses);
              if (upgraded) name = upgraded;
            } else if (token && token !== '__guest__') {
              try {
                const [place] = await Location.reverseGeocodeAsync({
                  latitude: lat,
                  longitude: lon,
                });
                if (place) {
                  const parts = [
                    place.name,
                    place.district ?? place.subregion ?? place.city,
                  ].filter(Boolean);
                  if (parts.length > 0) name = parts.join(', ');
                }
              } catch {}
            }
          }
        }
      } catch {}

      if (cancelled) return;
      setLocationName(name);
      try {
        const result = await checkServiceability(lat, lon);
        if (!cancelled) setServiceable(result.serviceable);
      } catch {}
      if (cancelled) return;
      setCoords({ lat, lon });
      writeLastKnownLocation({ lat, lon, name, addressId: selectedAddressId });
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleLocationSelect = useCallback(
    async (name: string, lat: number, lon: number, addressId?: string) => {
      const shortName = name.split(',').slice(0, 2).join(',').trim();
      setLocationName(shortName);
      setSelectedAddressId(addressId);
      // Resolve tag for the picked address. If the user picked a saved one,
      // look it up in their list; otherwise clear so the header falls back
      // to "Current location".
      if (addressId && token && token !== '__guest__') {
        try {
          const saved = await listAddresses(token);
          const match = saved.find((a) => a.id === addressId);
          setAddressTag(match?.tag ?? undefined);
        } catch {
          setAddressTag(undefined);
        }
      } else {
        setAddressTag(undefined);
      }
      const result = await checkServiceability(lat, lon).catch(() => ({
        serviceable: true,
      }));
      posthog.capture('location_changed', {
        serviceable: result.serviceable,
        has_saved_address: !!addressId,
      });
      setServiceable(result.serviceable);
      setCoords({ lat, lon });
      writeLastKnownLocation({ lat, lon, name: shortName, addressId });
    },
    [token, posthog],
  );

  // ── Action routing ────────────────────────────────────────────────────────
  const handleAction = useCallback(
    (action: SduiAction) => {
      if (action.type === 'load_more') {
        // Lazy section pagination — append to the section's data when supported.
        // The current SDUI section data shape doesn't yet expose an `append`
        // hook, so we only fetch + log; the BFF returns the next cursor and
        // section data which a future renderer can wire up.
        void fetchSection(action.section_id, action.cursor);
        return;
      }
      // navigation.navigate's overloads are tightly coupled to MainStackParamList.
      // The SDUI action layer is generic over screen names, so we cast through
      // `any` at the boundary — any unknown screen will simply no-op at runtime
      // because react-navigation logs the warning itself.
      void executeAction(action, {
        navigation: {
          navigate: (screen, params) =>
            (navigation as unknown as { navigate: (s: string, p?: object) => void })
              .navigate(screen, params),
        },
        apiFetch,
        showToast: (message, variant) =>
          variant === 'error' ? showError(message)
            : variant === 'success' ? showSuccess(message)
            : showInfo(message),
      });
    },
    [navigation, fetchSection],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: SduiSection; index: number }) => (
      <SectionRenderer section={item} position={index} onAction={handleAction} />
    ),
    [handleAction],
  );

  const keyExtractor = useCallback(
    (item: SduiSection, index: number) => `${item.id}-${index}`,
    [],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  const locationModal = (
    <LocationSelector
      visible={locationModalVisible}
      onClose={() => setLocationModalVisible(false)}
      onLocationSelect={handleLocationSelect}
      mode={{ kind: 'change-location' }}
      theme={isDark ? 'dark' : 'light'}
    />
  );

  if (bootstrapping || (loading && !page)) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: sc.bg }} edges={['top']}>
        <Bloom />
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 80 }}
        >
          <HomeScreenSkeleton />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!serviceable) {
    return (
      <>
        <NotServiceableScreen
          locationName={locationName}
          onChangeLocation={() => setLocationModalVisible(true)}
        />
        {locationModal}
      </>
    );
  }

  // Split the SDUI sections into the scrolling feed and the blocks HomeScreen
  // renders itself (the hero is the FlashList ListHeaderComponent below).
  const part = partitionHomeSections(page?.sections ?? []);
  const sections = part.feed;
  const heroData = part.greetingHero?.data;
  const carouselData = part.heroCarousel?.data;
  const headerPromo = part.headerPromo?.data;
  // Default-on: render the indicator unless the section ships and sets visible=false.
  const showUpcoming = part.upcomingBooking ? part.upcomingBooking.data.visible !== false : true;

  // Hero layer: the greeting hero is ALWAYS page 0 (with its pull-to-refresh
  // easter egg). When the config ships a hero_carousel, its slides become pages
  // 1..n — the hero slides left to reveal them. Built from core RN (HeroPager),
  // so no native pager-view dependency that could crash older app builds.
  const heroNode = (
    <HomeHero
      name={user?.name ?? undefined}
      greeting={heroData?.greeting}
      titleLines={heroData?.title_lines}
      showMascot={heroData?.show_mascot}
      eggTranslateX={heroTransX}
      eggTranslateY={heroTransY}
      eggScale={heroScale}
      eggRotation={heroRotZ}
      eyeOpacity={heroEye}
      winkProgress={heroWink}
      showFace={heroShowFace}
    />
  );
  const Header = (
    <HeroPager
      hero={heroNode}
      slides={carouselData?.slides ?? []}
      behavior={{
        autoplay: carouselData?.autoplay,
        intervalMs: carouselData?.interval_ms,
        loop: carouselData?.loop,
        restartOnFocus: carouselData?.restart_on_focus,
      }}
      onAction={handleAction}
    />
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: sc.bg }} edges={['top']}>
      <Bloom />

      <HomeHeader
        locationName={locationName}
        onLocationPress={() => setLocationModalVisible(true)}
        selectedAddressId={selectedAddressId}
        addressTag={addressTag}
        promo={headerPromo}
        onAction={handleAction}
      />

      {/* DEV SHORTCUT — remove before shipping */}
      {__DEV__ && (
        <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingBottom: 4 }}>
          <TouchableOpacity
            onPress={() => navigation.navigate('BookingConfirmed', {
              bookingId: 'dev-instant-001', totalCents: 49900, bookingType: 'instant',
              serviceName: 'Deep Clean', durationMinutes: 120,
              helperName: 'Ravi K.', helperRating: 4.8, etaMinutes: 6,
              addressLine: '314c, Gf, Orchid Island, Sec 51',
            })}
            style={{ backgroundColor: 'rgba(34,197,94,0.15)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}
          >
            <Text style={{ color: '#22C55E', fontSize: 10, fontWeight: '700' }}>DEV: Instant</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('BookingConfirmed', {
              bookingId: 'dev-scheduled-001', totalCents: 49900, bookingType: 'scheduled',
              serviceName: 'Deep Clean', durationMinutes: 120,
              slot: 'Sat, 31 May · 10:00 AM',
              addressLine: '314c, Gf, Orchid Island, Sec 51',
            })}
            style={{ backgroundColor: 'rgba(96,165,250,0.15)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}
          >
            <Text style={{ color: '#60A5FA', fontSize: 10, fontWeight: '700' }}>DEV: Scheduled</Text>
          </TouchableOpacity>
        </View>
      )}

      <View key={isDark ? 'dark' : 'light'} style={{ flex: 1 }}>
        <SduiErrorBoundary resetKey={page?.config_hash}>
        <FlashList
          data={sections}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          estimatedItemSize={200}
          ListHeaderComponent={Header}
          contentContainerStyle={{ paddingBottom: 200, backgroundColor: 'transparent' }}
          showsVerticalScrollIndicator={false}
          extraData={page?.config_hash}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              // Hide the native pull spinner by tinting it the on-screen page
              // colour. iOS ignores a transparent / near-zero-alpha tint (falls
              // back to the default gray spinner), so the tint MUST be opaque.
              // The visible bg in the refresh zone is ScreenBg's near-white
              // overlay (~#FBF9F6, sampled from the rendered screen) — lighter
              // than the bare theme token — so match that in light mode; dark
              // mode uses the flat theme bg.
              tintColor={isDark ? sc.bg : '#FBF9F6'}
              colors={[isDark ? sc.bg : '#FBF9F6']}
              progressBackgroundColor={isDark ? sc.bg : '#FBF9F6'}
              style={{ opacity: 0 }}
            />
          }
        />
        </SduiErrorBoundary>
      </View>

      <HomeCartBar selectedAddressId={selectedAddressId} />
      {showUpcoming ? <UpcomingBookingIndicator /> : null}
      {locationModal}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
