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
//   - NotServiceableScreen (when geocoded coords are out of zone).
//
// What moved into SDUI sections:
//   - HeroCarousel slides (promos + greeting)
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
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
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
import { HeroRefreshFlyer } from '../../components/home/HeroRefreshFlyer';
import { ZopRefresh } from '../../components/home/ZopRefresh';
import { SduiErrorBoundary } from '../../components/SduiErrorBoundary';
import { executeAction } from '../../sdui/ActionHandler';
import { setAnalyticsContext } from '../../analytics/context';
import { showError, showSuccess, showInfo } from '../../utils/toast';
import { haptics } from '../../utils/haptics';
import { usePostHog } from 'posthog-react-native';
import { usePrefetch } from '../../context/PrefetchContext';
import { writeLastKnownLocation, readLastKnownLocation } from '../../utils/locationCache';
import type { SduiAction, SduiSection } from '../../sdui/types';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
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

// Top-overscroll distance (px) that triggers a custom pull-to-refresh. No native
// RefreshControl is used, so the pull is detected from the scroll offset.
const PULL_TRIGGER = 90;

// How far the list is held down while refreshing (recreates the RefreshControl
// rubber-band hold). The carousel fly rest adds this during refresh so the Zop
// tracks the held card.
const HOLD_OFFSET = 64;

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
  // True when the user has no saved address — the header then prompts
  // "Add a new address" and its tap opens the add-new flow directly instead of
  // showing a reverse-geocoded GPS location.
  const [noSavedAddress, setNoSavedAddress] = useState(false);
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

  // Re-fetch the page when Home regains focus (skip the initial mount focus —
  // useSduiPage already fetches on mount). Picks up server-side config changes
  // like a kill switch being toggled off without needing a manual pull.
  const didMountFocus = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!didMountFocus.current) {
        didMountFocus.current = true;
        return;
      }
      refetch();
    }, [refetch]),
  );

  // ── Pull-to-refresh easter egg ────────────────────────────────────────────
  // Choreography (driven by the pull-to-refresh scroll trigger):
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
  // Which hero-pager page is showing (0 = hero card). Drives which refresh
  // mascot plays: full Zop fly on the home card, simple spinner on promo cards.
  const [heroPage, setHeroPage] = useState(0);
  // True for the whole fly+wink window (outlives `refreshing`, which flips off
  // when the Zop lands ~before the wink) so the overlay mascot stays mounted
  // through the wink.
  const [heroAnimating, setHeroAnimating] = useState(false);
  // Measured hero-card window rect — lets the carousel refresh overlay sit
  // pixel-exact on the in-card mascot regardless of header/DEV-chip height.
  const heroCardRef = useRef<View>(null);
  // Live list scroll offset, mirrored into a shared value (UI thread, for the
  // overlay's card tracking) and a plain ref (JS thread, for scroll-normalizing
  // the measured hero rect).
  const scrollY = useSharedValue(0);
  const scrollYJS = useRef(0);

  // Scroll-away header: hides while scrolling down, returns the moment the
  // user scrolls up (or is near the top). translateY slides it out;
  // the matching negative marginBottom lets the list ride up to fill the gap.
  const headerH = useSharedValue(0);
  const headerHidden = useSharedValue(0); // 0 = shown, 1 = off-screen
  const headerTarget = useRef(0);
  const lastScrollY = useRef(0);
  // While the header is hidden or sliding, every measureInWindow on the list
  // side is shifted by the collapse — anchors measured then are garbage
  // (mascot flying to random spots). Measures are blocked during that window
  // and re-taken once the header settles back.
  const headerAnimUntil = useRef(0);
  const setHeaderHidden = useCallback((t: 0 | 1) => {
    if (headerTarget.current === t) return; // don't restart an in-flight timing
    headerTarget.current = t;
    headerAnimUntil.current = Date.now() + 280;
    headerHidden.value = withTiming(t, {
      duration: 240,
      easing: Easing.bezier(0.33, 1, 0.68, 1),
    });
    if (t === 0) {
      setTimeout(() => {
        measureHeroCard();
        measureListWrap();
      }, 300);
    }
  }, [headerHidden]); // eslint-disable-line react-hooks/exhaustive-deps -- measure fns declared below, stable
  const headerTopInset = insets.top;
  const headerStyle = useAnimatedStyle(() => ({
    zIndex: 10,
    // Clear the safe-area inset too, or the bar parks inside the status-bar
    // zone and stays visible. Layout gap (marginBottom) is just headerH.
    transform: [{ translateY: -(headerH.value + headerTopInset) * headerHidden.value }],
    marginBottom: -headerH.value * headerHidden.value,
  }));
  // heroRect.y is stored in SCROLL-0 coords (measured y + scroll offset at
  // measure time) so the overlay can re-derive the live position from the
  // current scroll on the UI thread.
  const [heroRect, setHeroRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const heroAnimatingRef = useRef(false);
  const measureHeroCard = useCallback(() => {
    // Skip while the fly is playing — measureInWindow would bake the hold
    // translate / mid-animation scroll into the rest anchor. Same for the
    // scroll-away header: hidden or mid-slide shifts everything; a remeasure
    // is scheduled when it settles (see setHeaderHidden).
    if (heroAnimatingRef.current) return;
    if (headerTarget.current !== 0 || Date.now() < headerAnimUntil.current) return;
    heroCardRef.current?.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) setHeroRect({ x, y: y + scrollYJS.current, w, h });
    });
  }, []);
  useEffect(() => { heroAnimatingRef.current = heroAnimating; }, [heroAnimating]);
  const heroTransX  = useSharedValue(0);
  const heroTransY  = useSharedValue(0);
  const heroScale   = useSharedValue(1);
  const heroRotZ    = useSharedValue(0);
  const heroEye     = useSharedValue(1);
  const heroWink    = useSharedValue(0);
  // Manual "hold" — recreates the RefreshControl rubber-band hold without the
  // native control. While refreshing, the list is translated down HOLD_OFFSET
  // (a gap opens at the top where the Zop plays); it springs back to 0 when the
  // refresh completes. Driven from onRefresh; applied to the list wrapper.
  const holdY = useSharedValue(0);
  const holdStyle = useAnimatedStyle(() => ({ transform: [{ translateY: holdY.value }] }));
  // Card-ride factor for the fly overlay: 1 = glued to the card (launch and
  // landing), 0 = fixed screen position (mid-air hover in the hold gap above
  // the card). Animated in lock-step with the fly choreography in onRefresh.
  const heroRide = useSharedValue(1);

  // Window top of the list area (below header/DEV chips). The fly overlay is
  // clipped to this region so the mascot can never draw OVER the fixed header
  // — when the card slides under the header (user scrolls mid-animation), the
  // mascot slides under with it, exactly like the in-card mascot would.
  const [listTop, setListTop] = useState(0);
  const listWrapRef = useRef<View>(null);
  const measureListWrap = useCallback(() => {
    // Same header-settle guard as measureHeroCard — a collapsed/sliding
    // header shifts the wrapper's window position.
    if (headerTarget.current !== 0 || Date.now() < headerAnimUntil.current) return;
    listWrapRef.current?.measureInWindow((_x, y) => {
      if (y > 0) setListTop(y);
    });
  }, []);

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
  // Mid-flight hover centre: a FIXED screen spot — the centre of the 64px
  // hold gap that opens at the top of the list while refreshing. That gap is
  // reserved empty space (the list is held down by HOLD_OFFSET), so the
  // mascot can never collide with content or the header. Deliberately NOT
  // derived from heroRect measurements — measured math is what sent the
  // mascot to random places. Falls back to 88 (matches ZopRefresh.tsx)
  // until listTop is measured.
  const TARGET_TOP = listTop > 0 ? listTop + HOLD_OFFSET / 2 : 60 + 56 / 2;
  const flyTargetX = SCREEN_W / 2 - zopRestX;
  const flyTargetY = TARGET_TOP - zopRestY; // negative — Zop flies UP
  const FLY_SCALE  = 56 / 130;             // matches small loading Zop

  const onRefresh = useCallback(async () => {
    haptics.medium();
    setRefreshing(true);
    setHeroAnimating(true);

    // Open the hold: ease the list down so a gap appears at the top (where the
    // Zop plays), mimicking the RefreshControl rubber-band hold. Springs back
    // when the choreography lands (see RETURN_AT below).
    cancelAnimation(holdY);
    holdY.value = withTiming(HOLD_OFFSET, { duration: 220, easing: Easing.out(Easing.cubic) });

    // Cancel any in-flight animations so a re-trigger reads cleanly.
    cancelAnimation(heroTransX);
    cancelAnimation(heroTransY);
    cancelAnimation(heroScale);
    cancelAnimation(heroRotZ);
    cancelAnimation(heroEye);
    cancelAnimation(heroWink);
    cancelAnimation(heroRide);

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
    // Detach from the card for the hover (the gap doesn't move with the held
    // card), re-attach on the same spring as the return so landing is exactly
    // the card point. Starts at 1 (launches FROM the card's current position).
    heroRide.value = 1;
    heroRide.value = withSequence(
      withTiming(0, { duration: FLY_MS, easing: Easing.out(Easing.cubic) }),
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

      // Close the hold: spring the list back up (the rubber-band release).
      holdY.value = withSpring(0, { damping: 16, stiffness: 170, mass: 0.9 });

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
    heroTransX, heroTransY, heroScale, heroRotZ, heroEye, heroWink, holdY, heroRide,
  ]);

  // Wink AFTER `refreshing` flips false (the list has already rubber-banded back
  // to rest since there's no native hold). Small delay so the wink reads as a
  // post-landing beat.
  const prevRefreshing = useRef(false);
  useEffect(() => {
    if (prevRefreshing.current && !refreshing) {
      const t = setTimeout(() => {
        heroWink.value = withSequence(
          withTiming(1, { duration: 140, easing: Easing.out(Easing.cubic) }),
          withDelay(100, withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) })),
        );
      }, 350);
      // Keep the overlay mascot mounted until the wink finishes (~350 + 440ms),
      // then hand back to the idle in-card mascot.
      const tEnd = setTimeout(() => setHeroAnimating(false), 1000);
      prevRefreshing.current = refreshing;
      return () => { clearTimeout(t); clearTimeout(tEnd); };
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
      let savedAddresses = prefetched?.addresses ?? null;
      const fromPrefetch = resolveNameFromAddresses(lat, lon, savedAddresses);
      if (fromPrefetch) name = fromPrefetch;

      if (!cancelled) {
        setLocationName(name);
        setCoords({ lat, lon });
        setBootstrapping(false);
      }

      // Prefetch may omit the address list this session. Fetch the definitive
      // list so the "Add a new address" prompt only appears when the user truly
      // has none — otherwise we'd show it despite a saved address existing.
      if (!savedAddresses && token && token !== '__guest__') {
        savedAddresses = await listAddresses(token).catch(() => null);
        if (!cancelled && savedAddresses) {
          const resolved = resolveNameFromAddresses(lat, lon, savedAddresses);
          if (resolved) { name = resolved; setLocationName(resolved); }
        }
      }
      if (!cancelled && savedAddresses) {
        setNoSavedAddress(savedAddresses.length === 0);
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
              if (!cancelled) setNoSavedAddress(false);
            } else if (token && token !== '__guest__') {
              // No saved address: prompt the user to add one instead of showing
              // a reverse-geocoded GPS location they never chose. Coords are
              // still kept for the serviceability check below.
              if (!cancelled) setNoSavedAddress(true);
              name = 'Add a new address';
            }
          }
        }
      } catch {}

      if (cancelled) return;
      setLocationName(name);
      try {
        const result = await checkServiceability(lat, lon);
        // Only an actual server answer may flip the gate — a transient error
        // (backend restart, dropped request) must not flash the "not in your
        // area" screen at a user who is in zone.
        if (!cancelled && result.authoritative) setServiceable(result.serviceable);
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
      if (addressId) setNoSavedAddress(false);
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
      const result = await checkServiceability(lat, lon);
      posthog.capture('location_changed', {
        serviceable: result.serviceable,
        has_saved_address: !!addressId,
      });
      // Same rule as the bootstrap check: only an authoritative server answer
      // may flip the gate (this path previously defaulted errors to TRUE while
      // bootstrap defaulted them to FALSE — both replaced by keep-last-state).
      if (result.authoritative) setServiceable(result.serviceable);
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
      mode={noSavedAddress ? { kind: 'add-new' } : { kind: 'change-location' }}
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
  // Hero layer: greeting hero is page 0; hero_carousel slides are pages 1..n.
  //
  // Refresh mascot:
  //   • No carousel — the hero is the direct list header, so the in-card mascot
  //     does the full fly+wink (original behaviour, never clipped).
  //   • Carousel — the hero sits inside HeroPager's ScrollView which clips a
  //     flying in-card mascot. So the in-card mascot stays idle (hidden while
  //     animating) and the fly is rendered as a root overlay (HeroRefreshFlyer)
  //     on page 0, or the simple ZopRefresh spinner on promo pages (below).
  const hasCarousel = (carouselData?.slides?.length ?? 0) > 0;
  // Mascot rest centre for the carousel overlay fly. Use the measured hero-card
  // window rect directly (pixel-exact): the in-card mascot sits at the card's
  // top-right — centre = (cardRight + 14 - 65, cardTop - 6 + 65). measureInWindow
  // returns window coords and the overlay's absolute top is measured from the
  // window origin too, so NO insets.top adjustment (subtracting it rendered the
  // mascot ~insets.top too high). Falls back to the computed screen coords.
  // heroRect is the SCROLL-0 rest anchor — a point defined on the card itself.
  // The overlay is rendered OUTSIDE the held list wrapper, so the card's live
  // displacement (the hold spring + any user scroll mid-animation) is applied
  // INSIDE HeroRefreshFlyer on the UI thread via the holdY/scrollY shared
  // values — no HOLD_OFFSET step-change here; the mascot rides the card and
  // the hover handoff happens at exactly the landing point.
  // No rest nudges: heroRect is measured pixel-exact, so the overlay's rest
  // must equal the in-card mascot's centre (heroRect.y + 59) EXACTLY — any
  // offset reads as a hop at launch and at the hover handoff (the old
  // FLY/REST nudges, tuned for the eyeballed-coords era, caused that jitter;
  // their mid-spring 5→4 flip when `refreshing` cleared added another 1px hop).
  const heroFlyRest = heroRect
    ? { x: heroRect.x + heroRect.w - 51, y: heroRect.y + 59 }
    : { x: zopRestX, y: zopRestY };
  const heroNode = (
    <HomeHero
      name={user?.name ?? undefined}
      greeting={heroData?.greeting}
      titleLines={heroData?.title_lines}
      // The hero ALWAYS lives inside HeroPager's horizontal ScrollView (even with
      // no carousel — 1 page), which clips a flying in-card mascot. So in BOTH
      // cases the in-card mascot stays static and is hidden while animating; the
      // fly is the root overlay (HeroRefreshFlyer), which is never clipped.
      showMascot={heroData?.show_mascot !== false && !heroAnimating}
      showFace={true}
      viewRef={heroCardRef}
      onLayout={measureHeroCard}
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
      onActiveChange={setHeroPage}
      paused={heroAnimating}
    />
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: sc.bg }} edges={['top']}>
      <Bloom />

      <Animated.View
        style={headerStyle}
        onLayout={(e) => { headerH.value = e.nativeEvent.layout.height; }}
      >
        <HomeHeader
          locationName={locationName}
          onLocationPress={() => setLocationModalVisible(true)}
          selectedAddressId={selectedAddressId}
          addressTag={addressTag}
          promo={headerPromo}
          onAction={handleAction}
        />
      </Animated.View>

      {/* List area wrapper — measured for listTop. NOT clipped itself: masking
          this whole region puts the list in its own compositing layer, which
          renders the backdrop gradient with a subtly different tint and drew a
          full-width seam at the header boundary in light mode. Only the fly
          overlay (below) gets a clipped container. */}
      <View ref={listWrapRef} onLayout={measureListWrap} style={{ flex: 1 }}>
      <Animated.View key={isDark ? 'dark' : 'light'} style={[{ flex: 1 }, holdStyle]}>
        <SduiErrorBoundary resetKey={page?.config_hash}>
        <FlashList
          data={sections}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          // Keep a separate recycle pool per section type. Without this, FlashList
          // recycles a cell from one section type into a different one on a config
          // swap, and the mismatched native view tree trips a Fabric mount
          // assertion (RCTComponentViewRegistry) → SIGABRT on the first swap.
          getItemType={(item) => (item as SduiSection).type}
          estimatedItemSize={200}
          ListHeaderComponent={Header}
          contentContainerStyle={{ paddingBottom: 200, backgroundColor: 'transparent' }}
          showsVerticalScrollIndicator={false}
          extraData={page?.config_hash}
          // Custom pull-to-refresh — NO native RefreshControl. That component owns
          // the iOS spinner, which can't be tinted or hidden on FlashList under the
          // New Architecture (and native appearance is locked light, so it's a
          // fixed gray). Instead the list rubber-bands at the top; when pulled past
          // PULL_TRIGGER we fire the refresh and the Zop choreography is the only
          // loader. No OS control = no gray spinner to theme, mask, or fight.
          scrollEventThrottle={16}
          onScroll={(e) => {
            // Mirror the offset BEFORE the re-trigger guard — the overlay's
            // card tracking needs it during the fly too.
            const y = e.nativeEvent.contentOffset.y;
            scrollY.value = y;
            scrollYJS.current = y;
            const dy = y - lastScrollY.current;
            lastScrollY.current = y;
            if (!refreshing && !heroAnimating) {
              if (y <= 8) setHeaderHidden(0);            // at/near top: always shown
              else if (dy < -2) setHeaderHidden(0);      // any upward scroll: return
              else if (dy > 2 && y > 56) setHeaderHidden(1); // scrolling down: slide away
            }
            if (refreshing || heroAnimating) return;
            if (y <= -PULL_TRIGGER) onRefresh();
          }}
        />
        </SduiErrorBoundary>
      </Animated.View>

      {/* Refresh mascot overlay — rendered INSIDE the clipped list wrapper
          (sibling of the list, not a child, so it doesn't scroll) but OUTSIDE
          HeroPager's ScrollView (which would clip an in-card fly). Used for
          BOTH carousel and non-carousel. Full Zop fly+wink on the home card
          (page 0); the simple ZopRefresh spinner on promo cards. Rest coords
          are window-based, so subtract listTop to convert into this wrapper. */}
      {heroPage === 0 && heroAnimating ? (
        // Clipped to the list area so the mascot can never draw over the
        // fixed header — it slides under the header edge with the card,
        // exactly like the in-card mascot would. Only mounted while the fly
        // plays, so the masked layer can't tint the resting screen.
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            overflow: 'hidden',
          }}
        >
          <HeroRefreshFlyer
            restX={heroFlyRest.x}
            restY={heroFlyRest.y - listTop}
            transX={heroTransX}
            transY={heroTransY}
            scale={heroScale}
            rotation={heroRotZ}
            scrollY={scrollY}
            holdY={holdY}
            ride={heroRide}
            eyeOpacity={heroEye}
            winkProgress={heroWink}
            showFace={heroShowFace}
          />
        </View>
      ) : null}
      </View>
      {hasCarousel && heroPage > 0 ? (
        // Promo cards: simple spinner, dropped below the header so it doesn't
        // overlap it — sits around where the home card's fly mascot travels.
        <ZopRefresh refreshing={refreshing} top={Math.round(insets.top + 56)} />
      ) : null}

      <HomeCartBar selectedAddressId={selectedAddressId} />
      {locationModal}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
