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

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
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

import LocationSelectorModal from '../../components/LocationSelectorModal';
import UpcomingBookingIndicator from '../../components/UpcomingBookingIndicator';
import { HomeHeader } from '../../components/home/HomeHeader';
import { HomeCartBar } from '../../components/home/HomeCartBar';
import NotServiceableScreen from './NotServiceableScreen';

import { useSduiPage } from '../../hooks/useSduiPage';
import { SectionRenderer } from '../../sdui/SectionRenderer';
import { executeAction } from '../../sdui/ActionHandler';
import { setAnalyticsContext } from '../../analytics/context';
import type { SduiAction, SduiSection } from '../../sdui/types';

const DEFAULT_LAT = 28.4357;
const DEFAULT_LON = 77.0763;

export default function HomeScreen() {
  const { token, user } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const [locationName, setLocationName] = useState('Detecting location…');
  const [selectedAddressId, setSelectedAddressId] = useState<string | undefined>();
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [serviceable, setServiceable] = useState(true);
  const [bootstrapping, setBootstrapping] = useState(true);

  // ── SDUI page fetch (driven by resolved coords) ───────────────────────────
  const { page, loading, fetchSection } = useSduiPage(
    'home',
    coords ? { lat: coords.lat, lon: coords.lon } : undefined,
  );

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
  useEffect(() => {
    let cancelled = false;
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
              let nearest = null as null | (typeof saved)[number];
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
                if (!cancelled) setSelectedAddressId(nearest.id);
              } else if (saved.length > 0) {
                const home = saved.find((a) => a.tag === 'Home') ?? saved[0];
                name = home.full_address.split(',').slice(0, 2).join(',').trim();
                if (!cancelled) setSelectedAddressId(home.id);
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

      if (cancelled) return;
      setLocationName(name);
      try {
        const result = await checkServiceability(lat, lon);
        if (!cancelled) setServiceable(result.serviceable);
      } catch {}
      if (cancelled) return;
      setCoords({ lat, lon });
      setBootstrapping(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleLocationSelect = useCallback(
    async (name: string, lat: number, lon: number, addressId?: string) => {
      setLocationName(name.split(',').slice(0, 2).join(',').trim());
      setSelectedAddressId(addressId);
      const result = await checkServiceability(lat, lon).catch(() => ({
        serviceable: true,
      }));
      setServiceable(result.serviceable);
      setCoords({ lat, lon });
    },
    [],
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
        showToast: (message, _variant) => Alert.alert('', message),
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
    <LocationSelectorModal
      visible={locationModalVisible}
      onClose={() => setLocationModalVisible(false)}
      onLocationSelect={handleLocationSelect}
    />
  );

  if (bootstrapping || (loading && !page)) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator color="#4F46E5" />
        </View>
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

  const sections = page?.sections ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HomeHeader
        locationName={locationName}
        onLocationPress={() => setLocationModalVisible(true)}
        selectedAddressId={selectedAddressId}
      />

      <FlashList
        data={sections}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={200}
        contentContainerStyle={{ paddingBottom: 140 }}
        showsVerticalScrollIndicator={false}
        extraData={page?.config_hash}
      />

      <HomeCartBar selectedAddressId={selectedAddressId} />
      <UpcomingBookingIndicator />
      {locationModal}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: '#FAFAFA' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
