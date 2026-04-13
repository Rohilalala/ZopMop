import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Alert,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import { lightColors, Colors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import LocationSelectorModal from '../../components/LocationSelectorModal';
import UpcomingBookingIndicator from '../../components/UpcomingBookingIndicator';
import { listServices, type ApiService } from '../../api/services';
import { checkServiceability } from '../../api/zones';
import { listAddresses } from '../../api/addresses';
import { useCart } from '../../context/CartContext';
import { useAuth } from '../../context/AuthContext';
import * as Location from 'expo-location';
import NotServiceableScreen from './NotServiceableScreen';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const H_PAD = 16;
const GRID_GAP = 10;
const SERVICE_CARD_WIDTH = (SCREEN_WIDTH - H_PAD * 2 - GRID_GAP * 2) / 3;

// ── Static fallback (shown while API loads or when DB has no seed data) ───────

// Only the top-6 most ordered services are shown on the home screen.
// The full catalog is available on AllServicesScreen.
const STATIC_SERVICES: ApiService[] = [
  { id: 'a1000000-0000-0000-0000-000000000001', emoji: '🧹', name: 'Sweeping &\nMopping', bg_color: '#EEF2FF', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count: 15300, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 1 },
  { id: 'a1000000-0000-0000-0000-000000000002', emoji: '🚿', name: 'Bathroom\nCleaning',  bg_color: '#F0FDFA', base_price_cents: 2500, mrp_cents: 15000, rating: 4.9, review_count: 17800, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 2 },
  { id: 'a1000000-0000-0000-0000-000000000003', emoji: '🍽️', name: 'Utensils',            bg_color: '#FFF7ED', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count: 13500, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 3 },
  { id: 'a1000000-0000-0000-0000-000000000004', emoji: '🧽', name: 'Dusting &\nWiping',  bg_color: '#F0FDF4', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count:  6500, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 4 },
  { id: 'a1000000-0000-0000-0000-000000000005', emoji: '🔪', name: 'Kitchen\nPrep',       bg_color: '#EFF6FF', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count:  3700, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 5 },
  { id: 'a1000000-0000-0000-0000-000000000006', emoji: '👕', name: 'Laundry',             bg_color: '#FDF4FF', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count:  4500, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 6 },
];

// Default coords: Gurugram (matches service_zones seed — always serviceable on first launch)
const DEFAULT_LAT = 28.4357;
const DEFAULT_LON = 77.0763;

export default function HomeScreen() {
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const [locationName, setLocationName] = useState('Detecting location…');
  const [services, setServices] = useState<ApiService[]>(STATIC_SERVICES);
  const [serviceable, setServiceable] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);

  // Silently refresh services whenever the screen comes into focus.
  useFocusEffect(
    useCallback(() => {
      listServices()
        .then(data => { if (data.length > 0) setServices(data.slice(0, 6)); })
        .catch(() => {});
    }, [])
  );

  useEffect(() => {
    listServices()
      .then(data => { if (data.length > 0) setServices(data.slice(0, 6)); })
      .catch(() => {});

    // Smart default: GPS → nearest saved address → Home-tagged address → fallback coords
    (async () => {
      let lat = DEFAULT_LAT;
      let lon = DEFAULT_LON;
      let name = 'Sector 51, Gurugram';

      // Try GPS first
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          lat = pos.coords.latitude;
          lon = pos.coords.longitude;

          // Try to match nearest saved address (within ~1 km)
          if (token && token !== '__guest__') {
            try {
              const saved = await listAddresses(token);
              let nearest = null;
              let minDist = Infinity;
              for (const addr of saved) {
                const d = Math.hypot(addr.lat - lat, addr.lon - lon);
                if (d < minDist) { minDist = d; nearest = addr; }
              }
              if (nearest && minDist < 0.009) {
                name = nearest.full_address.split(',').slice(0, 2).join(',').trim();
              } else if (saved.length > 0) {
                // Not near any saved address — use Home-tagged if exists, else first
                const home = saved.find(a => a.tag === 'Home') ?? saved[0];
                name = home.full_address.split(',').slice(0, 2).join(',').trim();
              } else {
                // No saved addresses — reverse-geocode current position using the
                // on-device geocoder. No API key needed or compiled into the bundle.
                try {
                  const [place] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
                  if (place) {
                    const parts = [place.name, place.district ?? place.subregion ?? place.city].filter(Boolean);
                    if (parts.length > 0) name = parts.join(', ');
                  }
                } catch { /* geocoder unavailable — keep default name */ }
              }
            } catch {
              // saved addresses unavailable — keep GPS coords, no name
            }
          }
        }
      } catch { /* GPS denied — use fallback */ }

      setLocationName(name);
      try {
        const svcResult = await checkServiceability(lat, lon);
        setServiceable(svcResult.serviceable);
      } catch {}
      setLoading(false);
    })();
  }, [token]);

  async function handleLocationSelect(name: string, lat: number, lon: number) {
    setLocationName(name.split(',').slice(0, 2).join(',').trim());
    const result = await checkServiceability(lat, lon).catch(() => ({ serviceable: true }));
    setServiceable(result.serviceable);
  }

  // LocationSelectorModal must be rendered in BOTH paths so it can open from NotServiceableScreen
  const locationModal = (
    <LocationSelectorModal
      visible={locationModalVisible}
      onClose={() => setLocationModalVisible(false)}
      onLocationSelect={(name, lat, lon) => handleLocationSelect(name, lat, lon)}
    />
  );

  if (loading) return <HomeSkeleton />;

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

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <Header locationName={locationName} onLocationPress={() => setLocationModalVisible(true)} />
        <HeroCard />
        <BookingCards />
        <ServicesGrid services={services} />
        <TrustStrip />
        <View style={{ height: 80 }} />
      </ScrollView>

      <CartBar />
      <UpcomingBookingIndicator />
      {locationModal}
    </SafeAreaView>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({ locationName, onLocationPress }: { locationName: string; onLocationPress: () => void }) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  return (
    <View style={s.header}>
      <TouchableOpacity style={s.locationBtn} activeOpacity={0.7} onPress={onLocationPress}>
        <Text style={s.locationLabel}>Your location</Text>
        <View style={s.locationRow}>
          <Text style={s.locationName} numberOfLines={1}>{locationName}</Text>
          <Text style={s.chevron}>⌄</Text>
        </View>
      </TouchableOpacity>

      <View style={s.headerRight}>
        <TouchableOpacity style={s.earnBtn} activeOpacity={0.8} onPress={() => navigation.navigate('Offers')}>
          <Text style={s.earnIcon}>🪙</Text>
          <Text style={s.earnText}>Earn ₹100</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.avatarBtn}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('Profile')}
        >
          <Text style={s.avatarIcon}>👤</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Hero Card ─────────────────────────────────────────────────────────────────

function HeroCard() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.heroCard}>
      <View style={[s.heroCircle, s.heroCircle1]} />
      <View style={[s.heroCircle, s.heroCircle2]} />
      <View style={s.heroPill}>
        <View style={s.heroPillDot} />
        <Text style={s.heroPillText}>Available Now</Text>
      </View>
      <Text style={s.heroTitle}>Expert help,{'\n'}at your doorstep</Text>
      <Text style={s.heroSub}>Trusted professionals, on demand</Text>
      <TouchableOpacity
        style={s.heroCTA}
        activeOpacity={0.85}
        onPress={() => navigation.navigate('AllServices')}
      >
        <Text style={s.heroCTAText}>Book a Service  →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Booking Cards ─────────────────────────────────────────────────────────────

function BookingCards() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>How would you like to book?</Text>
      <View style={s.bookingRow}>
        <TouchableOpacity
          style={s.bookingCard}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('AllServices', { instant: false })}
        >
          <View style={[s.bookingIconBox, { backgroundColor: c.primaryBg }]}>
            <Text style={s.bookingEmoji}>📅</Text>
          </View>
          <Text style={s.bookingCardTitle}>Schedule</Text>
          <Text style={s.bookingCardSub}>Pick your time</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.bookingCard, s.bookingCardInstant]}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('AllServices', { instant: true })}
        >
          <View style={s.timePill}><Text style={s.timePillText}>~30 min</Text></View>
          <View style={[s.bookingIconBox, { backgroundColor: '#F0FDFA' }]}>
            <Text style={s.bookingEmoji}>⚡</Text>
          </View>
          <Text style={s.bookingCardTitle}>Instant</Text>
          <Text style={s.bookingCardSub}>Get help now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Services Grid ─────────────────────────────────────────────────────────────

function ServicesGrid({ services }: { services: ApiService[] }) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.section}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>Popular Services</Text>
        <TouchableOpacity activeOpacity={0.7} onPress={() => navigation.navigate('AllServices')}>
          <Text style={s.seeAll}>See all</Text>
        </TouchableOpacity>
      </View>
      <View style={s.grid}>
        {services.map(service => (
          <ServiceCard key={service.id} service={service} />
        ))}
      </View>
    </View>
  );
}

function ServiceCard({ service }: { service: ApiService }) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { addItem, removeItem, items } = useCart();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const [busy, setBusy] = useState(false);

  // Check if this service is already in cart
  const cartItem = items.find(i => i.service_id === service.id);
  const inCart = !!cartItem;

  async function handleAdd() {
    if (busy) return;
    setBusy(true);
    try {
      await addItem(service.id, service.min_duration_minutes);
    } catch (err: any) {
      Alert.alert('Could not add to cart', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleIncrement() {
    if (busy || !cartItem) return;
    const newDuration = cartItem.duration_minutes + service.duration_step_minutes;
    if (newDuration > service.max_duration_minutes) return;
    setBusy(true);
    try {
      await addItem(service.id, newDuration);
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDecrement() {
    if (busy || !cartItem) return;
    setBusy(true);
    try {
      if (cartItem.duration_minutes <= service.min_duration_minutes) {
        // Remove from cart entirely
        await removeItem(cartItem.id);
      } else {
        await addItem(service.id, cartItem.duration_minutes - service.duration_step_minutes);
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <TouchableOpacity
      style={[s.serviceCard, { width: SERVICE_CARD_WIDTH }]}
      activeOpacity={inCart ? 1 : 0.85}
      onPress={() => { if (!inCart) navigation.navigate('ServiceAbout', { service }); }}
    >
      <View style={[s.serviceImgBox, { backgroundColor: service.bg_color || '#EEF2FF' }]}>
        <View style={s.ratingBadge}>
          <Text style={s.ratingText}>⭐ {service.rating}</Text>
        </View>
        <Text style={s.serviceEmoji}>{service.emoji ?? '🧹'}</Text>

        {inCart ? (
          // ── Inline stepper ──
          <View style={s.stepper}>
            <TouchableOpacity
              style={s.stepBtn}
              activeOpacity={0.7}
              onPress={handleDecrement}
              disabled={busy}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
            >
              {busy
                ? <ActivityIndicator size="small" color={c.primary} style={{ transform: [{ scale: 0.55 }] }} />
                : <Text style={s.stepBtnText}>−</Text>
              }
            </TouchableOpacity>
            <View style={s.stepCenter}>
              <Text style={s.stepCount}>{cartItem.duration_minutes}</Text>
              <Text style={s.stepLabel}>Min</Text>
            </View>
            <TouchableOpacity
              style={s.stepBtn}
              activeOpacity={0.7}
              onPress={handleIncrement}
              disabled={busy || cartItem.duration_minutes >= service.max_duration_minutes}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
            >
              <Text style={[
                s.stepBtnText,
                cartItem.duration_minutes >= service.max_duration_minutes && s.stepBtnDisabled,
              ]}>+</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // ── Plain add button ──
          <TouchableOpacity
            style={s.addBtn}
            activeOpacity={0.8}
            onPress={handleAdd}
            disabled={busy}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {busy
              ? <ActivityIndicator size="small" color={c.primary} style={{ transform: [{ scale: 0.7 }] }} />
              : <Text style={s.addBtnText}>+</Text>
            }
          </TouchableOpacity>
        )}
      </View>

      <Text style={s.serviceName} numberOfLines={2}>{service.name}</Text>
      <View style={s.priceRow}>
        <Text style={s.servicePrice}>₹{(service.base_price_cents / 100).toFixed(0)}</Text>
        {service.mrp_cents != null && (
          <Text style={s.serviceMrp}>₹{(service.mrp_cents / 100).toFixed(0)}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── Cart Bar ──────────────────────────────────────────────────────────────────

function CartBar() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { itemCount, subtotalCents } = useCart();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  if (itemCount === 0) return null;

  return (
    <View style={s.cartBar}>
      <View style={s.cartBarLeft}>
        <Text style={s.cartBarEmoji}>🛒</Text>
        <View>
          <Text style={s.cartBarCount}>
            {itemCount} service{itemCount > 1 ? 's' : ''}
          </Text>
          <Text style={s.cartBarSubtotal}>₹{(subtotalCents / 100).toFixed(0)} total</Text>
        </View>
      </View>
      <TouchableOpacity
        style={s.cartBarBtn}
        activeOpacity={0.85}
        onPress={() => navigation.navigate('Cart')}
      >
        <Text style={s.cartBarBtnText}>Go to cart  →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Trust Strip ───────────────────────────────────────────────────────────────

function TrustStrip() {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  const items = [
    { icon: '✅', label: 'Verified\nPros' },
    { icon: '🛡️', label: 'Background\nChecked' },
    { icon: '⭐', label: '4.9 Rated\nService' },
  ];
  return (
    <View style={s.section}>
      <View style={s.trustCard}>
        <Text style={s.trustTitle}>Reliable & Trustworthy</Text>
        <View style={s.trustRow}>
          {items.map((item, idx) => (
            <React.Fragment key={item.label}>
              <View style={s.trustItem}>
                <Text style={s.trustIcon}>{item.icon}</Text>
                <Text style={s.trustLabel}>{item.label}</Text>
              </View>
              {idx < items.length - 1 && <View style={s.trustDivider} />}
            </React.Fragment>
          ))}
        </View>
      </View>
    </View>
  );
}

// ── Skeleton Loading ──────────────────────────────────────────────────────────

function SkeletonBlock({
  pulse,
  w,
  h,
  r = Radius.md,
  style,
  borderColor,
}: {
  pulse: Animated.Value;
  w?: number | string;
  h: number;
  r?: number;
  style?: any;
  borderColor?: string;
}) {
  return (
    <Animated.View
      style={[
        { height: h, borderRadius: r, backgroundColor: borderColor ?? '#E5E7EB', opacity: pulse },
        w !== undefined ? { width: w } : { alignSelf: 'stretch' },
        style,
      ]}
    />
  );
}

function HomeSkeleton() {
  const pulse = useRef(new Animated.Value(0.5)).current;
  const c = useColors();
  const sk = useMemo(() => createSkeletonStyles(c), [c]);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 900, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  const p = pulse;
  const bc = c.border;

  return (
    <SafeAreaView style={sk.safe} edges={['top']}>
      <ScrollView
        style={sk.scroll}
        contentContainerStyle={sk.content}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={sk.header}>
          <View style={{ gap: 6 }}>
            <SkeletonBlock pulse={p} w={60} h={10} r={Radius.sm} borderColor={bc} />
            <SkeletonBlock pulse={p} w={150} h={18} borderColor={bc} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <SkeletonBlock pulse={p} w={90} h={30} r={Radius.full} borderColor={bc} />
            <SkeletonBlock pulse={p} w={36} h={36} r={Radius.full} borderColor={bc} />
          </View>
        </View>

        {/* Hero Card */}
        <SkeletonBlock pulse={p} h={150} r={Radius['2xl']} style={sk.hero} borderColor={bc} />

        {/* Booking cards section */}
        <View style={sk.section}>
          <SkeletonBlock pulse={p} w={170} h={20} style={{ marginBottom: 14 }} borderColor={bc} />
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <SkeletonBlock pulse={p} h={110} r={Radius.xl} style={{ flex: 1 }} borderColor={bc} />
            <SkeletonBlock pulse={p} h={110} r={Radius.xl} style={{ flex: 1 }} borderColor={bc} />
          </View>
        </View>

        {/* Services grid */}
        <View style={sk.section}>
          <View style={sk.sectionHeader}>
            <SkeletonBlock pulse={p} w={130} h={20} borderColor={bc} />
            <SkeletonBlock pulse={p} w={50} h={16} borderColor={bc} />
          </View>
          <View style={sk.grid}>
            {[0, 1, 2, 3, 4, 5].map(i => (
              <SkeletonBlock key={i} pulse={p} w={SERVICE_CARD_WIDTH} h={SERVICE_CARD_WIDTH * 1.5} r={Radius.xl} borderColor={bc} />
            ))}
          </View>
        </View>

        {/* Trust strip */}
        <View style={sk.section}>
          <SkeletonBlock pulse={p} h={100} r={Radius.xl} borderColor={bc} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

type C = typeof lightColors;

function createSkeletonStyles(c: C) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    scroll: { flex: 1 },
    content: { paddingBottom: 40 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: H_PAD,
      paddingTop: 12,
      paddingBottom: 16,
    },
    hero: {
      marginHorizontal: H_PAD,
      width: SCREEN_WIDTH - H_PAD * 2,
      marginBottom: 28,
    },
    section: { paddingHorizontal: H_PAD, marginBottom: 28 },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 14,
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  });
}

function createStyles(c: C) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    scroll: { flex: 1 },
    content: { paddingBottom: Spacing.base },

    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: H_PAD, paddingTop: 12, paddingBottom: 16,
    },
    locationBtn: { flex: 1 },
    locationLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, marginBottom: 2 },
    locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    locationName: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text, maxWidth: SCREEN_WIDTH * 0.42 },
    chevron: { fontSize: 16, color: c.textSecondary, marginTop: -2 },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    earnBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: c.primaryBg, paddingHorizontal: 10, paddingVertical: 6,
      borderRadius: Radius.full, borderWidth: 1, borderColor: `${c.primary}22`,
    },
    earnIcon: { fontSize: 12 },
    earnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.xs, color: c.primary },
    avatarBtn: {
      width: 36, height: 36, borderRadius: Radius.full,
      backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
    },
    avatarIcon: { fontSize: 18 },

    heroCard: {
      marginHorizontal: H_PAD, backgroundColor: c.primary,
      borderRadius: Radius['2xl'], padding: 24, paddingBottom: 28,
      overflow: 'hidden', marginBottom: 28,
    },
    heroCircle: { position: 'absolute', borderRadius: Radius.full, backgroundColor: '#FFFFFF' },
    heroCircle1: { width: 150, height: 150, opacity: 0.07, top: -55, right: -35 },
    heroCircle2: { width: 90, height: 90, opacity: 0.05, bottom: -25, right: 90 },
    heroPill: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: 'rgba(255,255,255,0.18)', alignSelf: 'flex-start',
      paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.full, marginBottom: 16,
    },
    heroPillDot: { width: 6, height: 6, borderRadius: Radius.full, backgroundColor: '#4ADE80' },
    heroPillText: { fontFamily: FontFamily.medium, fontSize: FontSize.xs, color: '#FFFFFF' },
    heroTitle: { fontFamily: FontFamily.extrabold, fontSize: FontSize['3xl'], color: '#FFFFFF', lineHeight: FontSize['3xl'] * 1.2, marginBottom: 8, letterSpacing: -0.5 },
    heroSub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: 'rgba(255,255,255,0.72)', marginBottom: 22 },
    heroCTA: { backgroundColor: '#FFFFFF', alignSelf: 'flex-start', paddingHorizontal: 20, paddingVertical: 12, borderRadius: Radius.xl },
    heroCTAText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.primary },

    section: { paddingHorizontal: H_PAD, marginBottom: 28 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
    sectionTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: c.text, letterSpacing: -0.2, marginBottom: 14 },
    seeAll: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: c.primary, marginBottom: 14 },

    bookingRow: { flexDirection: 'row', gap: 12 },
    bookingCard: { flex: 1, backgroundColor: c.white, borderRadius: Radius.xl, padding: 16, borderWidth: 1.5, borderColor: c.border, ...Shadow.sm, overflow: 'hidden' },
    bookingCardInstant: { borderColor: `${c.accent}44`, backgroundColor: c.background },
    bookingIconBox: { width: 48, height: 48, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
    bookingEmoji: { fontSize: 22 },
    bookingCardTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text, marginBottom: 3 },
    bookingCardSub: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },
    timePill: { position: 'absolute', top: 12, right: 12, backgroundColor: c.accent, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.full },
    timePillText: { fontFamily: FontFamily.semibold, fontSize: 10, color: '#FFFFFF' },

    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
    serviceCard: { backgroundColor: c.white, borderRadius: Radius.xl, overflow: 'hidden', borderWidth: 1, borderColor: c.border, ...Shadow.sm },
    serviceImgBox: { width: '100%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', position: 'relative' },
    ratingBadge: { position: 'absolute', top: 6, left: 6, backgroundColor: 'rgba(255,255,255,0.88)', paddingHorizontal: 5, paddingVertical: 2, borderRadius: Radius.sm },
    ratingText: { fontFamily: FontFamily.semibold, fontSize: 9, color: c.text },
    serviceEmoji: { fontSize: 32 },

    addBtn: {
      position: 'absolute', bottom: 6, right: 6,
      width: 26, height: 26, borderRadius: Radius.md,
      backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: c.border, ...Shadow.sm,
    },
    addBtnText: { fontFamily: FontFamily.bold, fontSize: 16, color: c.primary, lineHeight: 20, marginTop: -1 },

    stepper: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: 'rgba(255,255,255,0.96)',
      paddingHorizontal: 8, paddingVertical: 5,
      borderTopWidth: 1, borderTopColor: `${c.primary}22`,
    },
    stepBtn: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    stepBtnText: { fontFamily: FontFamily.bold, fontSize: 18, color: c.primary, lineHeight: 22 },
    stepBtnDisabled: { color: c.border },
    stepCenter: { alignItems: 'center', flex: 1 },
    stepCount: { fontFamily: FontFamily.bold, fontSize: 13, color: c.text, lineHeight: 16 },
    stepLabel: { fontFamily: FontFamily.regular, fontSize: 8, color: c.textMuted, lineHeight: 10 },

    serviceName: { fontFamily: FontFamily.semibold, fontSize: 11, color: c.text, paddingHorizontal: 8, paddingTop: 8, lineHeight: 16 },
    priceRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 10, paddingTop: 3 },
    servicePrice: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.text },
    serviceMrp: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, textDecorationLine: 'line-through' },

    cartBar: {
      position: 'absolute', bottom: 28, left: 24, right: 24,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: c.white,
      paddingHorizontal: 16, paddingVertical: 12,
      borderRadius: Radius['2xl'],
      borderWidth: 1, borderColor: c.border,
      ...Shadow.lg,
    },
    cartBarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    cartBarEmoji: { fontSize: 22 },
    cartBarCount: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.text },
    cartBarSubtotal: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted, marginTop: 1 },
    cartBarBtn: {
      backgroundColor: c.primary,
      paddingHorizontal: 18, paddingVertical: 10,
      borderRadius: Radius.xl,
      ...Shadow.sm,
    },
    cartBarBtnText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm, color: '#FFFFFF' },

    trustCard: { backgroundColor: c.white, borderRadius: Radius.xl, padding: 20, borderWidth: 1, borderColor: c.border, ...Shadow.sm },
    trustTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text, textAlign: 'center', marginBottom: 18 },
    trustRow: { flexDirection: 'row', alignItems: 'center' },
    trustItem: { flex: 1, alignItems: 'center', gap: 6 },
    trustIcon: { fontSize: 24 },
    trustLabel: { fontFamily: FontFamily.medium, fontSize: FontSize.xs, color: c.textSecondary, textAlign: 'center', lineHeight: 16 },
    trustDivider: { width: 1, height: 40, backgroundColor: c.border },
  });
}

