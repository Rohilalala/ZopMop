import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Dimensions,
  ActivityIndicator,
  Alert,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Location from 'expo-location';
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';

import type { MainStackParamList } from '../../types/navigation';
import { useCart } from '../../context/CartContext';
import { useAuth } from '../../context/AuthContext';
import { listServices, type ApiService } from '../../api/services';
import { checkServiceability } from '../../api/zones';
import { listAddresses } from '../../api/addresses';
import { getNearbyStats, getMyUsuals, type NearbyStats } from '../../api/insights';
import LocationSelectorModal from '../../components/LocationSelectorModal';
import UpcomingBookingIndicator from '../../components/UpcomingBookingIndicator';
import NotServiceableScreen from './NotServiceableScreen';

import { ScreenContainer, PressFx } from '../../components/ui';
import { HomeHeader } from '../../components/home/HomeHeader';
import { HeroCarousel } from '../../components/home/HeroCarousel';
import { GreetingHeroCard } from '../../components/home/GreetingHeroCard';
import { PromoCard } from '../../components/home/PromoCard';
import { LivePill } from '../../components/home/LivePill';
import { UsualsRow } from '../../components/home/UsualsRow';
import { HomeCartBar } from '../../components/home/HomeCartBar';
import { HomeFooter } from '../../components/home/HomeFooter';
import { HeroMascotOverlay } from '../../components/home/HeroMascotOverlay';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontSemi: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };

const DEFAULT_LAT = 28.4357;
const DEFAULT_LON = 77.0763;

const STATIC_SERVICES: ApiService[] = [
  { id: 'a1000000-0000-0000-0000-000000000001', emoji: '🧹', name: 'Sweeping & Mopping', bg_color: '#EEF2FF', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count: 15300, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 1 },
  { id: 'a1000000-0000-0000-0000-000000000002', emoji: '🚿', name: 'Bathroom Cleaning', bg_color: '#F0FDFA', base_price_cents: 2500, mrp_cents: 15000, rating: 4.9, review_count: 17800, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 2 },
  { id: 'a1000000-0000-0000-0000-000000000003', emoji: '🍽️', name: 'Utensils', bg_color: '#FFF7ED', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count: 13500, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 3 },
  { id: 'a1000000-0000-0000-0000-000000000004', emoji: '🧽', name: 'Dusting & Wiping', bg_color: '#F0FDF4', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count: 6500, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 4 },
  { id: 'a1000000-0000-0000-0000-000000000005', emoji: '🔪', name: 'Kitchen Prep', bg_color: '#EFF6FF', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count: 3700, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 5 },
  { id: 'a1000000-0000-0000-0000-000000000006', emoji: '👕', name: 'Laundry', bg_color: '#FDF4FF', base_price_cents: 2500, mrp_cents: 12500, rating: 4.9, review_count: 4500, min_duration_minutes: 30, max_duration_minutes: 90, duration_step_minutes: 15, is_active: true, display_order: 6 },
];

// Hero carousel slot height
const HERO_H = 280;

// ── Screen ───────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const { token, user } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const [locationName, setLocationName] = useState('Detecting location…');
  const [selectedAddressId, setSelectedAddressId] = useState<string | undefined>();
  const [services, setServices] = useState<ApiService[]>(STATIC_SERVICES);
  const [usuals, setUsuals] = useState<ApiService[]>([]);
  const [nearbyStats, setNearbyStats] = useState<NearbyStats | null>(null);
  const [serviceable, setServiceable] = useState(true);
  const [loading, setLoading] = useState(true);

  // Parallax scrollY
  const scrollY = useSharedValue(0);
  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollY.value = e.contentOffset.y;
    },
  });

  // Carousel page progress (0 = greeting slide; >0 → mascot slides out left)
  const carouselProgress = useSharedValue(0);

  // Hero translates upward at 1.5x scroll speed (parallax — top hides faster).
  const heroParallax = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(scrollY.value, [0, 400], [0, -200], Extrapolation.CLAMP),
      },
    ],
    opacity: interpolate(scrollY.value, [0, 220, 320], [1, 0.6, 0], Extrapolation.CLAMP),
  }));

  useFocusEffect(
    useCallback(() => {
      listServices()
        .then((data) => {
          if (data.length > 0) setServices(data);
        })
        .catch(() => {});
    }, []),
  );

  // Resolve location → check serviceable → fetch nearby stats + usuals
  useEffect(() => {
    listServices()
      .then((data) => {
        if (data.length > 0) setServices(data);
      })
      .catch(() => {});

    (async () => {
      let lat = DEFAULT_LAT;
      let lon = DEFAULT_LON;
      let name = 'Sector 51, Gurugram';

      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          lat = pos.coords.latitude;
          lon = pos.coords.longitude;

          if (token && token !== '__guest__') {
            try {
              const saved = await listAddresses(token);
              let nearest = null;
              let minDist = Infinity;
              for (const addr of saved) {
                const d = Math.hypot(addr.lat - lat, addr.lon - lon);
                if (d < minDist) {
                  minDist = d;
                  nearest = addr;
                }
              }
              if (nearest && minDist < 0.009) {
                name = nearest.full_address.split(',').slice(0, 2).join(',').trim();
                setSelectedAddressId(nearest.id);
              } else if (saved.length > 0) {
                const home = saved.find((a) => a.tag === 'Home') ?? saved[0];
                name = home.full_address.split(',').slice(0, 2).join(',').trim();
                setSelectedAddressId(home.id);
              } else {
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
            } catch {}
          }
        }
      } catch {}

      setLocationName(name);
      try {
        const svcResult = await checkServiceability(lat, lon);
        setServiceable(svcResult.serviceable);
      } catch {}
      setLoading(false);

      // Live stats — fail-soft (returns sensible default if endpoint missing).
      getNearbyStats(lat, lon).then(setNearbyStats);

      // Usuals — depends on services being loaded for ID resolution.
      if (token && token !== '__guest__') {
        getMyUsuals(token).then((ids) => {
          // Resolved later in derived `usualsResolved`.
          const seen = new Set(ids);
          if (ids.length > 0) {
            setUsuals(
              ids.map((id) => services.find((s) => s.id === id)).filter(Boolean) as ApiService[],
            );
          }
        });
      }
    })();
  }, [token]);

  // Re-resolve usuals once services load if backend returned IDs first.
  const usualsResolved = useMemo(() => {
    if (usuals.length > 0) {
      return usuals
        .map((u) => services.find((s) => s.id === u.id) ?? u)
        .filter(Boolean) as ApiService[];
    }
    // Fallback: top 3 popular services so the section never looks empty for new users.
    return services.slice(0, 3);
  }, [usuals, services]);

  async function handleLocationSelect(
    name: string,
    lat: number,
    lon: number,
    addressId?: string,
  ) {
    setLocationName(name.split(',').slice(0, 2).join(',').trim());
    setSelectedAddressId(addressId);
    const result = await checkServiceability(lat, lon).catch(() => ({ serviceable: true }));
    setServiceable(result.serviceable);
    getNearbyStats(lat, lon).then(setNearbyStats);
  }

  const locationModal = (
    <LocationSelectorModal
      visible={locationModalVisible}
      onClose={() => setLocationModalVisible(false)}
      onLocationSelect={(name, lat, lon, addressId) =>
        handleLocationSelect(name, lat, lon, addressId)
      }
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

  // Carousel slides: greeting first, then promos.
  const slides = [
    {
      key: 'greeting',
      render: () => <GreetingHeroCard name={user?.name?.split(' ')[0]} active />,
    },
    {
      key: 'promo-instant',
      render: () => (
        <PromoCard
          promo={{
            key: 'promo-instant',
            eyebrow: 'Now serving',
            title: 'Help in\n12 minutes.',
            body: 'Instant booking for cleaning, cooking & more.',
            cta: 'Book instant',
            bg: '#EEF2FF',
            accent: '#4F46E5',
            emoji: '⚡',
            onPress: () => navigation.navigate('AllServices', { instant: true }),
          }}
        />
      ),
    },
    {
      key: 'promo-roomies',
      render: () => (
        <PromoCard
          promo={{
            key: 'promo-roomies',
            eyebrow: 'Split bills',
            title: 'Share with\nyour roomies.',
            body: 'Add up to 4 housemates. One household, fairer bills.',
            cta: 'Set up Roomies',
            bg: '#F0FDFA',
            accent: '#0D9488',
            emoji: '🏠',
            onPress: () => navigation.navigate('RoomiesWelcome' as any),
          }}
        />
      ),
    },
    {
      key: 'promo-earn',
      render: () => (
        <PromoCard
          promo={{
            key: 'promo-earn',
            eyebrow: 'Refer & earn',
            title: 'Earn ₹100\nfor every friend.',
            body: 'Share ZopMop. Both get credits on first booking.',
            cta: 'Invite now',
            bg: '#FEF3C7',
            accent: '#B45309',
            emoji: '🪙',
            onPress: () => navigation.navigate('Offers'),
          }}
        />
      ),
    },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#FAFAFA' }} edges={['top']}>
      <HomeHeader
        locationName={locationName}
        onLocationPress={() => setLocationModalVisible(true)}
        selectedAddressId={selectedAddressId}
      />

      <Animated.ScrollView
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: 140 }}
        showsVerticalScrollIndicator={false}
        bounces
      >
        {/* Hero block w/ parallax — moves upward at 1.5x scroll speed */}
        <Animated.View
          style={[heroParallax, { height: HERO_H + 30 }]}
          // Allow mascot to overflow the page bounds.
        >
          <HeroCarousel slides={slides} height={HERO_H} progress={carouselProgress} />
          {/* Mascot lives at parent layer so it isn't clipped by PagerView */}
          <HeroMascotOverlay progress={carouselProgress} />
        </Animated.View>

        <LivePill stats={nearbyStats} loading={!nearbyStats} />

        <UsualsRow
          services={usualsResolved}
          onPress={(svc) => navigation.navigate('ServiceAbout', { service: svc })}
        />

        <PopularServices services={services} />

        <HomeFooter />
      </Animated.ScrollView>

      <HomeCartBar selectedAddressId={selectedAddressId} />
      <UpcomingBookingIndicator />
      {locationModal}
    </SafeAreaView>
  );
}

// ── Popular Services (horizontal scroll) ─────────────────────────────────────

function PopularServices({ services }: { services: ApiService[] }) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  return (
    <View style={{ marginTop: 32 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          paddingHorizontal: 20,
          marginBottom: 14,
        }}
      >
        <Text style={[fontExtra, { fontSize: 26, color: '#0F172A', letterSpacing: -0.4 }]}>
          Popular services
        </Text>
        <PressFx onPress={() => navigation.navigate('AllServices')}>
          <Text style={[fontSemi, { fontSize: 14, color: '#4F46E5' }]}>See all  →</Text>
        </PressFx>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
      >
        {services.map((svc, i) => (
          <Animated.View
            key={svc.id}
            entering={FadeInDown.duration(320).delay(i * 50)}
          >
            <ServiceCard service={svc} />
          </Animated.View>
        ))}
      </ScrollView>
    </View>
  );
}

function ServiceCard({ service }: { service: ApiService }) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { addItem, removeItem, items } = useCart();
  const [busy, setBusy] = useState(false);
  const cartItem = items.find((i) => i.service_id === service.id);
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

  async function handleInc() {
    if (busy || !cartItem) return;
    const next = cartItem.duration_minutes + service.duration_step_minutes;
    if (next > service.max_duration_minutes) return;
    setBusy(true);
    try {
      await addItem(service.id, next);
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDec() {
    if (busy || !cartItem) return;
    setBusy(true);
    try {
      if (cartItem.duration_minutes <= service.min_duration_minutes) {
        await removeItem(cartItem.id);
      } else {
        await addItem(
          service.id,
          cartItem.duration_minutes - service.duration_step_minutes,
        );
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PressFx
      onPress={() => {
        if (!inCart) navigation.navigate('ServiceAbout', { service });
      }}
      style={{
        width: 158,
        backgroundColor: '#FFFFFF',
        borderRadius: 20,
        borderWidth: 1,
        borderColor: '#F1F5F9',
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 2,
      }}
    >
      <View
        style={{
          width: '100%',
          aspectRatio: 1,
          backgroundColor: service.bg_color || '#EEF2FF',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        <View
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 3,
            backgroundColor: 'rgba(255,255,255,0.95)',
            paddingHorizontal: 7,
            paddingVertical: 3,
            borderRadius: 999,
          }}
        >
          <Text style={{ color: '#F59E0B', fontSize: 11 }}>★</Text>
          <Text style={[fontSemi, { fontSize: 11, color: '#0F172A' }]}>{service.rating}</Text>
        </View>
        <Text style={{ fontSize: 56 }}>{service.emoji ?? '🧹'}</Text>

        {inCart ? (
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: 'rgba(255,255,255,0.96)',
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderTopWidth: 1,
              borderTopColor: 'rgba(79,70,229,0.18)',
            }}
          >
            <PressFx onPress={handleDec} disabled={busy} scale={0.92}>
              {busy ? (
                <ActivityIndicator size="small" color="#4F46E5" />
              ) : (
                <Text style={[fontBold, { fontSize: 22, color: '#4F46E5' }]}>−</Text>
              )}
            </PressFx>
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={[fontBold, { fontSize: 14, color: '#0F172A' }]}>
                {cartItem.duration_minutes}
              </Text>
              <Text style={[fontReg, { fontSize: 9, color: '#9CA3AF' }]}>Min</Text>
            </View>
            <PressFx
              onPress={handleInc}
              disabled={busy || cartItem.duration_minutes >= service.max_duration_minutes}
              scale={0.92}
            >
              <Text
                style={[
                  fontBold,
                  {
                    fontSize: 22,
                    color:
                      cartItem.duration_minutes >= service.max_duration_minutes
                        ? '#E5E7EB'
                        : '#4F46E5',
                  },
                ]}
              >
                +
              </Text>
            </PressFx>
          </View>
        ) : (
          <PressFx
            onPress={handleAdd}
            disabled={busy}
            scale={0.9}
            style={{
              position: 'absolute',
              bottom: 10,
              right: 10,
              width: 38,
              height: 38,
              borderRadius: 12,
              backgroundColor: '#FFFFFF',
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: '#E5E7EB',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.1,
              shadowRadius: 4,
              elevation: 3,
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#4F46E5" />
            ) : (
              <Text style={[fontBold, { fontSize: 22, color: '#4F46E5', lineHeight: 24 }]}>+</Text>
            )}
          </PressFx>
        )}
      </View>

      <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 14 }}>
        <Text
          style={[fontBold, { fontSize: 14, color: '#0F172A', lineHeight: 18 }]}
          numberOfLines={2}
        >
          {service.name}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <Text style={[fontBold, { fontSize: 14, color: '#0F172A' }]}>
            ₹{(service.base_price_cents / 100).toFixed(0)}
          </Text>
          {service.mrp_cents != null && (
            <Text
              style={[
                fontReg,
                { fontSize: 11, color: '#9CA3AF', textDecorationLine: 'line-through' },
              ]}
            >
              ₹{(service.mrp_cents / 100).toFixed(0)}
            </Text>
          )}
        </View>
      </View>
    </PressFx>
  );
}

// ── Loading Skeleton ─────────────────────────────────────────────────────────

function HomeSkeleton() {
  return (
    <ScreenContainer edges={['top']}>
      <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View>
            <View style={{ backgroundColor: '#E5E7EB', borderRadius: 4, height: 10, width: 80, marginBottom: 6 }} />
            <View style={{ backgroundColor: '#E5E7EB', borderRadius: 4, height: 18, width: 160 }} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ backgroundColor: '#E5E7EB', borderRadius: 999, height: 32, width: 100 }} />
            <View style={{ backgroundColor: '#E5E7EB', borderRadius: 999, height: 38, width: 38 }} />
          </View>
        </View>
        <View style={{ backgroundColor: '#E5E7EB', borderRadius: 24, height: 280, marginTop: 12 }} />
        <View style={{ alignSelf: 'center', backgroundColor: '#E5E7EB', borderRadius: 999, height: 40, width: 280, marginTop: 12 }} />
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 24 }}>
          <View style={{ backgroundColor: '#E5E7EB', borderRadius: 22, height: 200, width: 168 }} />
          <View style={{ backgroundColor: '#E5E7EB', borderRadius: 22, height: 200, width: 168 }} />
        </View>
      </View>
    </ScreenContainer>
  );
}
