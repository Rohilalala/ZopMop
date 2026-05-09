// AllServicesScreen — design-system port of `preview/services-screen.html`.
//
// Composition:
//   • Bloom backdrop + dark page
//   • Sticky header (back, title + sub, search) + horizontal filter chips
//   • Sections grouped by service.category, OR a flat grid when a non-"all"
//     chip is active
//   • Service cards reuse GlassCard + ServiceThumb + serviceIcon (same vocabulary
//     as Home).
//   • Cart dock (HomeCartBar) + BottomTabBar (active="services").
//
// `instant: true` route param re-renders cards as direct InstantMatching CTAs
// (no add-to-cart, no stepper) — preserves the existing instant flow.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  
  Alert,
  Dimensions,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { LoadingSkeleton } from '../../components/skeletons/LoadingSkeleton';
import { Image } from 'expo-image';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { ZopSleeping } from '../../components/home/ZopSleeping';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { listServices, type ApiService } from '../../api/services';
import { getNearbyStats } from '../../api/insights';
import { useCart } from '../../context/CartContext';

import { Bloom } from '../../components/home/Bloom';
import { ZopRefresh } from '../../components/home/ZopRefresh';
import { GlassCard } from '../../components/home/GlassCard';
import { HomeCartBar } from '../../components/home/HomeCartBar';
import { ServiceThumb } from '../../components/home/ServiceThumb';
import { serviceIcon } from '../../components/home/serviceIcon';
import { PressFx } from '../../components/ui/PressFx';
import { showError } from '../../utils/toast';
import { haptics } from '../../utils/haptics';

const { width: SCREEN_W } = Dimensions.get('window');
const H_PAD     = 20;
const COL_GAP   = 14;
const NUM_COLS  = 2;
const CARD_W    = (SCREEN_W - H_PAD * 2 - COL_GAP) / NUM_COLS;

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

// ── Category grouping ───────────────────────────────────────────────────────

const CATEGORY_TITLES: Record<string, string> = {
  home_cleaning: 'Home Cleaning',
  kitchen:       'Kitchen Services',
  laundry:       'Laundry & Fabric Care',
  outdoor:       'Outdoor & Garden',
  vehicle:       'Vehicle Care',
  pet:           'Pet Care',
  other:         'Other Services',
};

const CATEGORY_ORDER = ['home_cleaning', 'kitchen', 'laundry', 'outdoor', 'vehicle', 'pet', 'other'];

interface Group { id: string; title: string; services: ApiService[] }

function groupServices(services: ApiService[]): Group[] {
  const map = new Map<string, Group>();
  for (const svc of services) {
    const catId = svc.category || 'other';
    const title = CATEGORY_TITLES[catId] ?? catId;
    if (!map.has(catId)) map.set(catId, { id: catId, title, services: [] });
    map.get(catId)!.services.push(svc);
  }
  const out: Group[] = [];
  for (const id of CATEGORY_ORDER) if (map.has(id)) out.push(map.get(id)!);
  for (const [id, group] of map) if (!CATEGORY_ORDER.includes(id)) out.push(group);
  return out.filter((g) => g.services.length > 0);
}

function isInstantSvc(s: ApiService): boolean {
  return s.min_duration_minutes <= 30;
}

// Night window — instant booking is closed between 20:00 and 06:00 since the
// pro fleet is off-duty. Matches the LivePill night gate.
const NIGHT_START_HOUR = 20;
const NIGHT_END_HOUR   = 6;
function isNightTime(d = new Date()): boolean {
  const hr = d.getHours();
  return hr >= NIGHT_START_HOUR || hr < NIGHT_END_HOUR;
}

// ── Screen ──────────────────────────────────────────────────────────────────

type Filter = 'all' | string;
type Mode   = 'schedule' | 'instant';

// Module-level cache so re-entering AllServices renders the grid synchronously
// from the previous fetch instead of flashing the skeleton again. Background
// refresh still runs via useFocusEffect to keep counts and listings fresh.
const servicesMemCache: {
  list: ApiService[];
  nearbyCount: number | null;
} = { list: [], nearbyCount: null };

export default function AllServicesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'AllServices'>>();
  const insets = useSafeAreaInsets();

  const [services, setServices] = useState<ApiService[]>(servicesMemCache.list);
  const [loading, setLoading]   = useState(servicesMemCache.list.length === 0);
  const [filter, setFilter]     = useState<Filter>('all');
  const [mode, setMode]         = useState<Mode>(route.params?.instant ? 'instant' : 'schedule');
  const [nearbyCount, setNearbyCount] = useState<number | null>(servicesMemCache.nearbyCount);
  // Two-phase refresh state:
  //   holdScreen — drives RefreshControl (keeps the scroll pulled down).
  //   zopActive  — drives ZopRefresh (true = spinning, false = play smile).
  // Holding the screen down for the smile burst means the user stays in the
  // refresh state until the entire animation has finished.
  const [holdScreen, setHoldScreen] = useState(false);
  const [zopActive,  setZopActive]  = useState(false);
  const instantMode = mode === 'instant';

  // Default coords: Sector 51, Gurugram — same fallback the home screen uses
  // before location resolves. AllServices doesn't get coords passed in, so
  // until a location context exists, this is the best we can do without
  // taking a permission detour.
  const lat = 28.4357;
  const lon = 77.0763;

  const fetchAll = useCallback(async () => {
    try {
      const [list, stats] = await Promise.all([
        listServices().catch(() => [] as ApiService[]),
        getNearbyStats(lat, lon).catch(() => null),
      ]);
      if (list.length > 0) {
        setServices(list);
        servicesMemCache.list = list;
      }
      if (stats) {
        setNearbyCount(stats.nearby_count);
        servicesMemCache.nearbyCount = stats.nearby_count;
      }
    } finally {
      setLoading(false);
    }
  }, [lat, lon]);

  useFocusEffect(
    useCallback(() => {
      fetchAll();
    }, [fetchAll]),
  );

  const onRefresh = useCallback(async () => {
    setHoldScreen(true);
    setZopActive(true);
    try {
      // Min 1100ms spin + network.
      await Promise.all([fetchAll(), new Promise((r) => setTimeout(r, 1100))]);
    } finally {
      // End spin → ZopRefresh plays smile burst (~1300ms total). Keep screen
      // held for that duration, then release so the scroll springs up.
      setZopActive(false);
      setTimeout(() => setHoldScreen(false), 1300);
    }
  }, [fetchAll]);

  // Mode + filter pipeline. Instant mode pre-filters to quick-turn services
  // (≤ 30 min). Then category chip narrows further.
  const modeFiltered = useMemo(() => {
    return instantMode ? services.filter(isInstantSvc) : services;
  }, [services, instantMode]);

  const visible = useMemo(() => {
    if (filter === 'all') return modeFiltered;
    return modeFiltered.filter((s) => (s.category || 'other') === filter);
  }, [modeFiltered, filter]);

  const groups = useMemo(() => {
    if (filter === 'all') return groupServices(visible);
    return [{ id: filter, title: '', services: visible }];
  }, [visible, filter]);

  // Category chips — All + every represented category in the mode-filtered set.
  const chips = useMemo(() => {
    const list: { key: Filter; label: string; count: number }[] = [
      { key: 'all', label: 'All', count: modeFiltered.length },
    ];
    for (const id of CATEGORY_ORDER) {
      const count = modeFiltered.filter((s) => (s.category || 'other') === id).length;
      if (count > 0) list.push({ key: id, label: CATEGORY_TITLES[id] ?? id, count });
    }
    const seen = new Set(['all', ...CATEGORY_ORDER]);
    for (const s of modeFiltered) {
      const id = s.category || 'other';
      if (!seen.has(id)) {
        const count = modeFiltered.filter((x) => (x.category || 'other') === id).length;
        list.push({ key: id, label: id, count });
        seen.add(id);
      }
    }
    return list;
  }, [modeFiltered]);

  return (
    <View style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <Bloom />

      <ScrollView
        // Background colour bleeds into the iOS overscroll gap so the area
        // above the content stays dark instead of flashing white.
        style={{ flex: 1, backgroundColor: '#0A0A0A' }}
        contentContainerStyle={{ paddingBottom: 200, backgroundColor: '#0A0A0A' }}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[0]}
        refreshControl={
          <RefreshControl
            refreshing={holdScreen}
            onRefresh={onRefresh}
            tintColor="transparent"
            colors={['transparent']}
            progressBackgroundColor="transparent"
          />
        }
      >
        {/* Sticky header — extends to the screen top (insets.top padding inside
            so the bg fills the status-bar area too). */}
        <View style={[styles.head, { paddingTop: insets.top + 10 }]}>
          <View style={styles.headRow}>
            <PressFx
              onPress={() => navigation.goBack()}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <Feather name="chevron-left" size={18} color="#FFFFFF" />
            </PressFx>

            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Explore Services</Text>
              <Text style={styles.subtitle}>
                {services.length} services
                {/* Show "N pros nearby" only in Instant mode during the day.
                    Schedule mode + night-mode-instant suppress the count. */}
                {instantMode && !isNightTime() && nearbyCount != null
                  ? ` · ${nearbyCount} pros nearby`
                  : ''}
              </Text>
            </View>

            <PressFx
              onPress={() => {/* search not built yet */}}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Search"
            >
              <Feather name="search" size={16} color="#FFFFFF" />
            </PressFx>
          </View>

          {/* Mode toggle: Schedule | Instant */}
          <ModeToggle mode={mode} onChange={setMode} />

          {/* Category chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: H_PAD, gap: 8 }}
            style={{ marginHorizontal: -H_PAD, marginTop: 12 }}
          >
            {chips.map((c) => (
              <Chip
                key={c.key}
                label={c.label}
                count={c.count}
                active={filter === c.key}
                onPress={() => setFilter(c.key)}
              />
            ))}
          </ScrollView>
        </View>

        {/* Body */}
        {loading ? (
          <LoadingSkeleton variant="list-grid" rows={6} />
        ) : instantMode && isNightTime() ? (
          <NightClosed />
        ) : (
          groups.map((group, gi) => (
            <View key={group.id} style={styles.section}>
              {group.title ? (
                <View style={styles.secHead}>
                  <Text style={styles.secTitle}>{group.title}</Text>
                  <Text style={styles.secMeta}>
                    {group.services.length} service{group.services.length === 1 ? '' : 's'}
                  </Text>
                </View>
              ) : (
                <View style={{ height: 12 }} />
              )}

              <View style={styles.grid}>
                {group.services.map((svc) => (
                  <ServiceCard key={`${gi}-${svc.id}`} service={svc} instantMode={instantMode} />
                ))}
              </View>
            </View>
          ))
        )}

        {!loading && groups.every((g) => g.services.length === 0) && (
          <View style={styles.emptyWrap}>
            <Feather name="search" size={32} color="rgba(255,255,255,0.4)" />
            <Text style={styles.emptyTitle}>No services available</Text>
            <Text style={styles.emptySub}>Try a different filter</Text>
          </View>
        )}
      </ScrollView>

      {!instantMode && <HomeCartBar />}
      <ZopRefresh refreshing={zopActive} />
    </View>
  );
}

// ── Mode toggle ─────────────────────────────────────────────────────────────

function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (next: Mode) => void;
}) {
  const [w, setW] = useState(0);
  const offset = useSharedValue(mode === 'schedule' ? 0 : 1);

  useEffect(() => {
    // Snappy spring — matches BookingsScreen tab glider exactly.
    offset.value = withSpring(mode === 'schedule' ? 0 : 1, {
      damping: 26,
      stiffness: 320,
      mass: 0.7,
      overshootClamping: false,
    });
  }, [mode]);

  const gliderWidth = Math.max((w - 8) / 2, 0);
  const gliderStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: 4 + offset.value * gliderWidth }],
  }));

  return (
    <View style={styles.modeWrap} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Animated.View
        style={[
          styles.modeGlider,
          { width: gliderWidth },
          gliderStyle,
        ]}
      />
      <ModeBtn
        active={mode === 'schedule'}
        onPress={() => onChange('schedule')}
        icon="calendar"
        label="Schedule"
      />
      <ModeBtn
        active={mode === 'instant'}
        onPress={() => onChange('instant')}
        icon="zap"
        label="Instant"
      />
    </View>
  );
}

function ModeBtn({
  active,
  onPress,
  icon,
  label,
}: {
  active: boolean;
  onPress: () => void;
  icon: 'calendar' | 'zap';
  label: string;
}) {
  return (
    <PressFx onPress={onPress} style={styles.modeBtn}>
      <Feather
        name={icon}
        size={14}
        color={active ? '#0D0D0F' : 'rgba(255,255,255,0.7)'}
      />
      <Text style={[styles.modeLabel, active && styles.modeLabelActive]}>{label}</Text>
    </PressFx>
  );
}

// ── Night closed empty state ────────────────────────────────────────────────
// Instant booking is shut between 20:00 and 06:00. Show a floating Zop and a
// "come back tomorrow" message instead of the service grid.

function NightClosed() {
  const float = useSharedValue(0);
  useEffect(() => {
    float.value = withRepeat(
      withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, []);
  const zopStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -float.value * 10 }],
  }));

  return (
    <View style={styles.nightWrap}>
      <Animated.View style={[zopStyle, { marginBottom: 28 }]}>
        <ZopSleeping size={200} />
      </Animated.View>
      <Text style={styles.nightTitle}>Pros are clocked out</Text>
      <Text style={styles.nightSub}>
        Instant booking is closed for the night.{'\n'}Come back tomorrow at 6 am.
      </Text>
      <Text style={styles.nightHint}>
        Tap <Text style={{ color: '#F5A300' }}>Schedule</Text> above to book ahead.
      </Text>
    </View>
  );
}

// ── Chip ────────────────────────────────────────────────────────────────────

function Chip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <PressFx onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
      <View style={[styles.chipCount, active && styles.chipCountActive]}>
        <Text style={[styles.chipCountText, active && styles.chipCountTextActive]}>
          {count}
        </Text>
      </View>
    </PressFx>
  );
}

// ── Service card ────────────────────────────────────────────────────────────

function ServiceCard({
  service,
  instantMode,
}: {
  service: ApiService;
  instantMode: boolean;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { addItem, removeItem, items } = useCart();
  const [busy, setBusy] = useState(false);

  const cartItem = items.find((i) => i.service_id === service.id);
  const inCart   = !!cartItem;

  const price  = `₹${(service.base_price_cents / 100).toFixed(0)}`;
  const mrp    = service.mrp_cents ? `₹${(service.mrp_cents / 100).toFixed(0)}` : null;
  const rating = service.rating?.toFixed(1) ?? null;
  const reviews =
    service.review_count > 1000
      ? `${(service.review_count / 1000).toFixed(1)}k`
      : `${service.review_count}`;
  const showReviews = service.review_count >= 1000;

  const handleCardPress = () => {
    haptics.light();
    if (instantMode) {
      navigation.navigate('InstantMatching', {
        serviceId: service.id,
        serviceName: service.name,
      });
      return;
    }
    if (!inCart) navigation.navigate('ServiceAbout', { service });
  };

  async function handleAdd() {
    if (busy) return;
    setBusy(true);
    try {
      await addItem(service.id, service.min_duration_minutes, service.name, service.base_price_cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Please try again.';
      showError(msg, { title: 'Could not add to cart' });
    } finally {
      setBusy(false);
    }
  }

  async function handleStep(delta: number) {
    if (busy || !cartItem) return;
    setBusy(true);
    try {
      const next = cartItem.duration_minutes + delta * service.duration_step_minutes;
      if (next < service.min_duration_minutes) {
        await removeItem(cartItem.id);
      } else if (next <= service.max_duration_minutes) {
        await addItem(service.id, next, service.name, Math.round((service.base_price_cents * next) / service.min_duration_minutes));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Please try again.';
      showError(msg);
    } finally {
      setBusy(false);
    }
  }

  const iconSrc = serviceIcon({ id: service.id, name: service.name });

  return (
    <PressFx
      onPress={handleCardPress}
      style={{ width: CARD_W }}
    >
      <GlassCard
        radius={18}
        style={{
          padding: 10,
          ...(inCart
            ? {
                shadowColor: '#F5A300',
                shadowOpacity: 0.18,
                shadowRadius: 18,
                shadowOffset: { width: 0, height: 8 },
                borderColor: '#F5A300',
                borderWidth: 1.5,
              }
            : null),
        }}
      >
        <View style={{ height: 102, position: 'relative' }}>
          <ServiceThumb height={102} radius={12} />

          {/* glyph */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {iconSrc ? (
              <Image
                source={iconSrc}
                contentFit="contain"
                style={{
                  width: '78%',
                  height: '78%',
                  shadowColor: '#0D0D0F',
                  shadowOffset: { width: 0, height: 12 },
                  shadowOpacity: 0.32,
                  shadowRadius: 18,
                }}
              />
            ) : (
              <Feather name="package" size={40} color="rgba(255,255,255,0.7)" />
            )}
          </View>

          {/* rating chip */}
          {rating && (
            <View style={styles.ratingChip}>
              <Text style={{ color: '#F5A300', fontSize: 10 }}>★</Text>
              <Text style={[fontBold, { color: '#0D0D0F', fontSize: 10 }]}>
                {rating}
                {showReviews ? ` · ${reviews}` : ''}
              </Text>
            </View>
          )}

          {/* add fab OR stepper */}
          {!instantMode && (
            inCart ? (
              <View style={styles.stepper}>
                <PressFx
                  onPress={() => handleStep(-1)}
                  style={styles.stepBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
                  disabled={busy}
                >
                  {busy
                    ? <LoadingBars size="small" color="#F5A300" />
                    : <Feather name="minus" size={16} color="#F5A300" />
                  }
                </PressFx>
                <View style={styles.stepMid}>
                  <Text style={[fontBold, { color: '#0D0D0F', fontSize: 12 }]}>
                    {cartItem.duration_minutes}
                  </Text>
                  <Text
                    style={[
                      fontSemi,
                      {
                        color: '#7A7A7E',
                        fontSize: 8.5,
                        letterSpacing: 0.5,
                        marginTop: 1,
                      },
                    ]}
                  >
                    MIN
                  </Text>
                </View>
                <PressFx
                  onPress={() => handleStep(1)}
                  style={styles.stepBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                  disabled={busy || cartItem.duration_minutes >= service.max_duration_minutes}
                >
                  <Feather
                    name="plus"
                    size={16}
                    color={
                      cartItem.duration_minutes >= service.max_duration_minutes
                        ? 'rgba(245,163,0,0.35)'
                        : '#F5A300'
                    }
                  />
                </PressFx>
              </View>
            ) : (
              <PressFx
                onPress={handleAdd}
                disabled={busy}
                style={styles.addFab}
              >
                {busy
                  ? <LoadingBars size="small" color="#F5A300" />
                  : <Feather name="plus" size={16} color="#F5A300" />
                }
              </PressFx>
            )
          )}
        </View>

        {/* meta */}
        <Text
          style={[fontBold, styles.cardName]}
          numberOfLines={2}
        >
          {service.name.replace(/\n/g, ' ')}
        </Text>
        <View style={styles.priceRow}>
          <Text style={[fontExtra, { color: '#FFFFFF', fontSize: 14 }]}>{price}</Text>
          {mrp && (
            <Text
              style={[
                fontMed,
                {
                  color: 'rgba(255,255,255,0.35)',
                  fontSize: 11,
                  textDecorationLine: 'line-through',
                },
              ]}
            >
              {mrp}
            </Text>
          )}
          <Text
            style={[
              fontSemi,
              {
                fontSize: 10.5,
                color: 'rgba(255,255,255,0.45)',
                marginLeft: 'auto',
              },
            ]}
          >
            {service.min_duration_minutes}m
          </Text>
        </View>
      </GlassCard>
    </PressFx>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },

  head: {
    backgroundColor: 'rgba(10,10,10,0.92)',
    paddingTop: 10,
    paddingBottom: 14,
    paddingHorizontal: H_PAD,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.05)',
    zIndex: 30,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  title: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 24,
    color: '#FFFFFF',
    letterSpacing: -0.6,
    lineHeight: 26,
  },
  subtitle: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 2,
  },

  chip: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  chipActive: {
    backgroundColor: '#0D0D0F',
    borderColor: '#0D0D0F',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  chipLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12.5,
    color: 'rgba(255,255,255,0.7)',
  },
  chipLabelActive: { color: '#F5A300' },
  chipCount: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  chipCountActive: { backgroundColor: 'rgba(245,163,0,0.2)' },
  chipCountText: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 10,
    color: 'rgba(255,255,255,0.6)',
  },
  chipCountTextActive: { color: '#F5A300' },

  // Mode toggle (Schedule | Instant) — segmented control with sliding glider.
  modeWrap: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: 4,
    position: 'relative',
  },
  modeGlider: {
    position: 'absolute',
    top: 4,
    left: 0,
    bottom: 4,
    borderRadius: 9,
    backgroundColor: '#F5A300',
    shadowColor: '#F5A300',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 4,
  },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 9,
    zIndex: 1,
  },
  modeLabel: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
    letterSpacing: -0.13,
  },
  modeLabelActive: { color: '#0D0D0F' },

  loadWrap: { padding: 60, alignItems: 'center' },

  section: { paddingHorizontal: H_PAD, paddingTop: 22 },
  secHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  secTitle: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 15,
    color: '#FFFFFF',
    letterSpacing: -0.15,
  },
  secMeta: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
  },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: COL_GAP,
  },

  ratingChip: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.96)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    zIndex: 3,
  },
  addFab: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#0D0D0F',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    zIndex: 3,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
  },
  stepper: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    right: 6,
    height: 34,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    backgroundColor: 'rgba(255,255,255,0.96)',
    zIndex: 3,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    borderWidth: 0.5,
    borderColor: 'rgba(245,163,0,0.3)',
  },
  stepBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepMid: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
  },

  cardName: {
    fontSize: 13,
    color: '#FFFFFF',
    letterSpacing: -0.2,
    lineHeight: 16,
    marginTop: 10,
    minHeight: 32,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    marginTop: 4,
  },

  // Night-closed empty state for instant mode after 8pm.
  nightWrap: {
    paddingTop: 60,
    paddingBottom: 60,
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  nightTitle: {
    fontFamily: 'PlusJakartaSans_800ExtraBold',
    fontSize: 24,
    color: '#FFFFFF',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  nightSub: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 10,
  },
  nightHint: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    marginTop: 24,
  },

  emptyWrap: {
    paddingTop: 80,
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  emptySub: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
  },
});
