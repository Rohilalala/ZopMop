import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Animated,
  TouchableOpacity,
  Dimensions,
  Easing,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import * as Location from 'expo-location';
import { FontFamily } from '../../theme';
import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import Zop from '../../components/Zop';
import { serviceIcon } from '../../components/home/serviceIcon';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import { createInstantBooking, getMatchStatus } from '../../api/matching';
import { UnpaidBookingsError } from '../../api/users';
import { apiFetch } from '../../api/client';
import { BASE_URL } from '../../api/config';
import { showError } from '../../utils/toast';
import { readLastKnownLocation } from '../../utils/locationCache';

const { width: W } = Dimensions.get('window');

// Visual completion bar fills toward (but never reaches) 92% over this window —
// the soft "usually under 30s" expectation. Matching itself is NOT bounded by
// this; the backend invite chain drives the real terminal state via polling.
const COMPLETION_WINDOW = 30000;
// After this many seconds with no match, the "Switch to scheduled instead"
// escape appears and the copy shifts to the calmer "still searching" state.
const SWITCH_AFTER_S = 30;
// Hard safety net: if polling never resolves (network black hole), fall back to
// the busy screen so the user is never stuck on an endless spinner.
const SAFETY_TIMEOUT = 90000;

const HERO = Math.min(280, W * 0.7);
const RING_BASE = 80;

type ScreenState = 'searching' | 'busy' | 'no_pros' | 'matched';

type Props = {
  route: RouteProp<MainStackParamList, 'InstantMatching'>;
};

export default function InstantMatchingScreen({ route }: Props) {
  const { serviceId, serviceName, durationMinutes } = route.params;
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();
  const { addItem } = useCart();
  const c = useC();
  const { isDark } = useTheme();
  const ringPeak = isDark ? 0.6 : 0.45;
  const s = useMemo(() => makeStyles(c), [c]);

  // Mirror live deps into refs so the long-running match effect (which is
  // intentionally mount-only — restarting it would cancel and recreate the
  // booking) always reads the freshest value without re-running.
  const tokenRef = useRef(token);
  const navigationRef = useRef(navigation);
  const serviceIdRef = useRef(serviceId);
  const serviceNameRef = useRef(serviceName);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { navigationRef.current = navigation; }, [navigation]);
  useEffect(() => { serviceIdRef.current = serviceId; }, [serviceId]);
  useEffect(() => { serviceNameRef.current = serviceName; }, [serviceName]);

  const [screenState, setScreenState] = useState<ScreenState>('searching');
  const [elapsed, setElapsed] = useState(0);
  const [priceCents, setPriceCents] = useState(0);
  const [addressLabel, setAddressLabel] = useState<string | null>(null);

  const longWait = elapsed >= SWITCH_AFTER_S;

  const progress = useRef(new Animated.Value(0)).current;
  const zopRot = useRef(new Animated.Value(0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;
  // Four expanding pulse rings, staggered.
  const rings = useRef([0, 1, 2, 3].map(() => new Animated.Value(0))).current;

  const bookingIdRef = useRef<string | null>(null);
  const priceCentsRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matchedRef = useRef(false);
  const userCancelledRef = useRef(false);
  const matchedHelperRef = useRef<{
    name: string;
    phone: string;
    rating: number;
    lat: number;
    lng: number;
    eta_minutes: number;
  } | null>(null);

  // ── Looping decorative animations ──────────────────────────────────────────
  useEffect(() => {
    const zopLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(zopRot, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(zopRot, { toValue: -1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(zopRot, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    const shimmerLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.delay(350),
      ]),
    );
    const ringLoops = rings.map((r, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 500),
          Animated.timing(r, { toValue: 1, duration: 2000, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true }),
          Animated.timing(r, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );
    zopLoop.start();
    shimmerLoop.start();
    ringLoops.forEach((l) => l.start());
    return () => {
      zopLoop.stop();
      shimmerLoop.stop();
      ringLoops.forEach((l) => l.stop());
    };
  }, [zopRot, shimmer, rings]);

  // ── Elapsed-seconds counter (drives the "Searching for Ns" pill + switch CTA) ─
  useEffect(() => {
    if (screenState !== 'searching') return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [screenState]);

  // ── Booking + match poll (mount-only — see comment) ─────────────────────────
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    let cancelled = false;
    const safeTimeout = (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      pendingTimers.current.push(id);
      return id;
    };

    async function run() {
      // Optimistic progress (Uber/Rapido feel): sprint early, decelerate, and
      // creep asymptotically toward ~97% — never completes/stalls until the
      // real match navigates away. The bar reflects confidence, not a timer.
      Animated.sequence([
        Animated.timing(progress, { toValue: 0.7, duration: 7000, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        Animated.timing(progress, { toValue: 0.9, duration: 14000, easing: Easing.out(Easing.quad), useNativeDriver: false }),
        Animated.timing(progress, { toValue: 0.985, duration: 40000, easing: Easing.linear, useNativeDriver: false }),
      ]).start();

      // Safety net only — NOT the matching deadline. Searching continues past
      // 30s (with the switch CTA shown); this just prevents an infinite spinner
      // if polling never resolves.
      safetyRef.current = safeTimeout(() => {
        if (cancelled || matchedRef.current) return;
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        progress.stopAnimation();
        const bid = bookingIdRef.current;
        const tkn = tokenRef.current;
        if (bid && tkn && tkn !== '__guest__') {
          apiFetch(`${BASE_URL}/bookings/${bid}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tkn}` },
          }).catch(() => {});
        }
        setScreenState('busy');
      }, SAFETY_TIMEOUT);

      const initialToken = tokenRef.current;
      if (!initialToken || initialToken === '__guest__') {
        safeTimeout(() => { if (!cancelled) setScreenState('busy'); }, COMPLETION_WINDOW);
        return;
      }

      let bookingId: string | null = null;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (!cancelled) {
            showError(
              'We need your location to find pros near you. Please enable location access in Settings and try again.',
              { title: 'Location Required' },
            );
            navigationRef.current.goBack();
          }
          return;
        }

        let lat: number;
        let lng: number;
        try {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
        } catch {
          if (!cancelled) {
            showError('Could not get your current location. Please try again.', { title: 'Location Unavailable' });
            navigationRef.current.goBack();
          }
          return;
        }

        try {
          // P16: prefer the cached last-known address name (user-meaningful
          // tag like "Home" or "M-Block, Sector 51") so the helper's dashboard
          // doesn't show the literal string 'User Location'. Fall back to
          // formatted lat/lng — never to a hardcoded label.
          const cached = await readLastKnownLocation().catch(() => null);
          const addressLine =
            cached?.name && cached.name.trim().length > 0
              ? cached.name
              : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
          if (!cancelled) setAddressLabel(addressLine);
          const booking = await createInstantBooking(
            tokenRef.current!,
            serviceIdRef.current,
            addressLine,
            lat,
            lng,
          );
          bookingId = booking.id;
          bookingIdRef.current = bookingId;
          priceCentsRef.current = booking.price_paise ?? 0;
          if (!cancelled) setPriceCents(booking.price_paise ?? 0);
        } catch (err) {
          if (err instanceof UnpaidBookingsError && !cancelled) {
            const totalRupees = (err.totalPaise / 100).toFixed(2);
            Alert.alert(
              'Settle pending payments',
              `You have ${err.count} unpaid booking(s) totaling ₹${totalRupees}. Please settle them before booking again.`,
              [
                { text: 'Cancel', style: 'cancel', onPress: () => navigationRef.current.goBack() },
                {
                  text: 'View Bookings',
                  onPress: () => {
                    navigationRef.current.goBack();
                    navigationRef.current.navigate('Bookings');
                  },
                },
              ],
            );
          }
          return;
        }
      } catch {
        return;
      }

      pollRef.current = setInterval(async () => {
        if (!bookingId || cancelled) return;
        try {
          const tkn = tokenRef.current;
          if (!tkn) return;
          const status = await getMatchStatus(tkn, bookingId);
          if (status.status === 'matched' && status.helper) {
            matchedRef.current = true;
            // P17: 'Your Pro' fallback only when backend omits helper.name on
            // a 'matched' response — should always be set in practice.
            matchedHelperRef.current = {
              name: status.helper.name || 'Your Pro',
              phone: status.helper.phone || '',
              rating: status.helper.rating,
              lat: status.helper.lat ?? 0,
              lng: status.helper.lng ?? 0,
              eta_minutes: status.helper.eta_minutes,
            };
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (safetyRef.current) { clearTimeout(safetyRef.current); safetyRef.current = null; }
            progress.stopAnimation();
            if (!cancelled && !userCancelledRef.current) {
              navigationRef.current.replace('BookingConfirmed', {
                bookingId: bookingId!,
                totalCents: priceCentsRef.current,
                serviceId: serviceIdRef.current,
                serviceName: serviceNameRef.current,
                helperName: status.helper.name || 'Your Pro',
                helperPhone: status.helper.phone,
                helperRating: status.helper.rating,
                bookingType: 'instant',
              });
            }
          } else if (status.status === 'failed' || (status.status === 'matched' && !status.helper)) {
            if (pollRef.current) clearInterval(pollRef.current);
            if (safetyRef.current) { clearTimeout(safetyRef.current); safetyRef.current = null; }
            if (!cancelled) {
              progress.stopAnimation();
              // Backend marks chain-exhausted bookings with booking_status
              // 'no_pro_available'; everything else (network errors, user
              // cancels) falls through to the generic busy screen.
              const nextState: ScreenState =
                status.booking_status === 'no_pro_available' ? 'no_pros' : 'busy';
              setScreenState(nextState);
            }
          }
        } catch { /* network — keep polling */ }
      }, 3000);
    }

    run();
    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (safetyRef.current) { clearTimeout(safetyRef.current); safetyRef.current = null; }
      pendingTimers.current.forEach(clearTimeout);
      pendingTimers.current = [];
      const bid = bookingIdRef.current;
      const tkn = tokenRef.current;
      if (bid && !matchedRef.current && tkn && tkn !== '__guest__') {
        apiFetch(`${BASE_URL}/bookings/${bid}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tkn}` },
        }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: see comment above; deps read via refs
  }, []);

  // Cancel the in-flight instant search: stop polling, kill the safety net, and
  // hit /cancel so the backend clears the Redis match keys and stops dispatch
  // (no orphaned pro invite). Idempotent — safe to call more than once.
  function cancelInstant() {
    userCancelledRef.current = true;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (safetyRef.current) { clearTimeout(safetyRef.current); safetyRef.current = null; }
    progress.stopAnimation();
    const bid = bookingIdRef.current;
    const tkn = tokenRef.current;
    if (bid && tkn && tkn !== '__guest__') {
      apiFetch(`${BASE_URL}/bookings/${bid}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tkn}` },
      }).catch(() => {});
    }
  }

  function handleCancel() {
    const helper = matchedHelperRef.current;
    const bookingId = bookingIdRef.current;

    if (matchedRef.current && helper && bookingId) {
      Alert.alert(
        'Pro Already Assigned',
        'One of our pros has accepted your request. Are you sure you still want to cancel?',
        [
          {
            text: 'No, Continue Booking',
            style: 'cancel',
            onPress: () => {
              navigation.replace('BookingConfirmed', {
                bookingId,
                totalCents: priceCentsRef.current,
                serviceId,
                serviceName,
                helperName: helper.name,
                helperPhone: helper.phone,
                helperRating: helper.rating,
                bookingType: 'instant',
              });
            },
          },
          {
            text: 'Yes, Cancel',
            style: 'destructive',
            onPress: () => {
              userCancelledRef.current = true;
              apiFetch(`${BASE_URL}/bookings/${bookingId}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              }).catch(() => {});
              navigation.goBack();
            },
          },
        ],
      );
    } else {
      // Cancel the instant search, then return to wherever they came from
      // (Cart/confirm) — back-navigation, not a hardcoded "home".
      cancelInstant();
      navigation.goBack();
    }
  }

  // Switch to scheduled. ORDER MATTERS: cancel the instant search FIRST (stop
  // dispatch, clear Redis match keys) so no pro can match an abandoned booking,
  // THEN seed the cart with this service and hand off to the Cart screen, which
  // owns the full scheduled flow (address → slot → pay).
  async function handleSwitchToScheduled() {
    cancelInstant();
    // min_duration_minutes carried via route params; fall back defensively.
    const dur = durationMinutes ?? 60;
    try {
      await addItem(serviceId, dur, serviceName, priceCentsRef.current);
    } catch { /* CartContext rolls back its optimistic add on failure */ }
    navigation.navigate('Cart');
  }

  const progressWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const zopSpin = zopRot.interpolate({ inputRange: [-1, 1], outputRange: ['-5deg', '5deg'] });
  const shimmerX = shimmer.interpolate({ inputRange: [0, 1], outputRange: [-60, 240] });

  if (screenState === 'busy') {
    return <BusyScreen onRetry={() => navigation.goBack()} onBack={() => navigation.goBack()} />;
  }

  if (screenState === 'no_pros') {
    return (
      <NoProsScreen
        onWaitAndRetry={() => navigation.goBack()}
        onReschedule={() => {
          showError(
            'Reschedule coming soon. Use the Bookings tab to manage existing bookings.',
            { title: 'Reschedule unavailable' },
          );
        }}
        onCancelRefund={() => {
          const bid = bookingIdRef.current;
          const tkn = tokenRef.current;
          Alert.alert(
            'Cancel booking?',
            'The booking is already cancelled because no pros were available. Any payment will be refunded automatically.',
            [
              { text: 'Close', style: 'cancel' },
              {
                text: 'OK',
                onPress: () => {
                  if (bid && tkn && tkn !== '__guest__') {
                    apiFetch(`${BASE_URL}/bookings/${bid}/cancel`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tkn}` },
                    }).catch(() => {});
                  }
                  navigationRef.current.goBack();
                },
              },
            ],
          );
        }}
      />
    );
  }

  if (screenState === 'matched') {
    return <MatchedFlash />;
  }

  const iconSrc = serviceIcon({ id: serviceId, name: serviceName });

  // Fixed full-screen — NO scroll. Sections distribute within the viewport.
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Bloom />
      <View style={s.container}>

        {/* Topbar */}
        <View style={s.topbar}>
          <TouchableOpacity style={s.iconBtn} activeOpacity={0.7} onPress={handleCancel} accessibilityLabel="Cancel matching">
            <Feather name="chevron-left" size={18} color={c.text} />
          </TouchableOpacity>
        </View>

        {/* Hero + copy (flexes to absorb slack) */}
        <View style={s.hero}>
          <View style={s.ringField}>
            {rings.map((r, i) => (
              <Animated.View
                key={i}
                pointerEvents="none"
                style={[
                  s.ring,
                  {
                    opacity: r.interpolate({ inputRange: [0, 1], outputRange: [ringPeak, 0] }),
                    transform: [{ scale: r.interpolate({ inputRange: [0, 1], outputRange: [1, 3.5] }) }],
                  },
                ]}
              />
            ))}
            <Animated.View style={{ transform: [{ rotate: zopSpin }] }}>
              <Zop mode="custom" size={84} autoEnter={false} />
            </Animated.View>
          </View>

          <Text style={s.title}>{longWait ? 'Still searching…' : 'Finding your pro…'}</Text>
          <Text style={s.subtitle}>
            {longWait
              ? "It's busier than usual. We're finding a great pro for you."
              : "We're matching you with the best available pro nearby"}
          </Text>

          <View style={s.completion}>
            <Animated.View style={[s.fill, longWait && s.fillWarn, { width: progressWidth }]} />
            {/* Optimistic sweeping highlight — bar always looks alive (Uber/Rapido feel) */}
            <Animated.View
              pointerEvents="none"
              style={[s.shimmer, { transform: [{ translateX: shimmerX }] }]}
            />
          </View>
        </View>

        {/* Booking summary */}
        <View style={s.summary}>
          <View style={s.summaryTop}>
            <View style={s.svcIcon}>
              {iconSrc ? (
                <Image source={iconSrc} style={s.svcImg} resizeMode="contain" />
              ) : (
                <Feather name="package" size={22} color={c.amber} />
              )}
            </View>
            <View style={s.svcMeta}>
              <Text style={s.svcName} numberOfLines={1}>{serviceName}</Text>
            </View>
            {priceCents > 0 && (
              <View style={s.price}>
                <Text style={s.priceText}>₹{Math.round(priceCents / 100)}</Text>
              </View>
            )}
          </View>

          {!!addressLabel && (
            <>
              <View style={s.divider} />
              <View style={s.addrRow}>
                <View style={s.pin}>
                  <Feather name="map-pin" size={15} color={c.amber} />
                </View>
                <View style={s.addr}>
                  <Text style={s.addrLabel}>SERVICE AT</Text>
                  <Text style={s.addrVal} numberOfLines={1}>{addressLabel}</Text>
                </View>
              </View>
            </>
          )}
        </View>

        {/* Cancel row — switch CTA appears only after 30s */}
        <View style={s.cancelRow}>
          {longWait && (
            <TouchableOpacity activeOpacity={0.7} onPress={handleSwitchToScheduled}>
              <Text style={s.switchText}>Switch to scheduled instead</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity activeOpacity={0.7} onPress={handleCancel}>
            <Text style={s.ghostText}>Cancel matching</Text>
          </TouchableOpacity>
        </View>

      </View>
    </SafeAreaView>
  );
}

// ── Terminal states (busy / no pros / matched) ───────────────────────────────
function BusyScreen({ onRetry, onBack }: { onRetry: () => void; onBack: () => void }) {
  const c = useC();
  const s = useMemo(() => makeStyles(c), [c]);
  const fadeIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [fadeIn]);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Bloom />
      <Animated.View style={[s.stateContainer, { opacity: fadeIn }]}>
        <View style={s.stateIcon}>
          <Feather name="clock" size={40} color={c.amber} />
        </View>
        <Text style={s.title}>All our pros are busy</Text>
        <Text style={s.stateSub}>
          Our professionals are all on jobs right now. Please try again in a few minutes.
        </Text>
        <TouchableOpacity style={s.retryBtn} activeOpacity={0.88} onPress={onRetry}>
          <Text style={s.retryBtnText}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.backBtn} activeOpacity={0.7} onPress={onBack}>
          <Text style={s.ghostText}>Go Back</Text>
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView>
  );
}

function NoProsScreen({
  onWaitAndRetry,
  onReschedule,
  onCancelRefund,
}: {
  onWaitAndRetry: () => void;
  onReschedule: () => void;
  onCancelRefund: () => void;
}) {
  const c = useC();
  const s = useMemo(() => makeStyles(c), [c]);
  const fadeIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [fadeIn]);
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Bloom />
      <Animated.View style={[s.stateContainer, { opacity: fadeIn }]}>
        <View style={s.stateIcon}>
          <Feather name="users" size={40} color={c.amber} />
        </View>
        <Text style={s.title}>No pros available right now</Text>
        <Text style={s.stateSub}>Try again in a few minutes or reschedule for later</Text>
        <TouchableOpacity style={s.retryBtn} activeOpacity={0.88} onPress={onWaitAndRetry}>
          <Text style={s.retryBtnText}>Wait and retry</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.secondaryBtn} activeOpacity={0.88} onPress={onReschedule}>
          <Text style={s.secondaryBtnText}>Reschedule</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.backBtn} activeOpacity={0.7} onPress={onCancelRefund}>
          <Text style={s.ghostText}>Cancel and refund</Text>
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView>
  );
}

function MatchedFlash() {
  const c = useC();
  const s = useMemo(() => makeStyles(c), [c]);
  const scale = useRef(new Animated.Value(0.4)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 14 }),
      Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();
  }, [scale, opacity]);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Bloom />
      <Animated.View style={[s.stateContainer, { opacity }]}>
        <Animated.View style={[s.stateIcon, { transform: [{ scale }] }]}>
          <Feather name="check" size={44} color={c.green} />
        </Animated.View>
        <Text style={[s.title, { color: c.green }]}>Pro Matched</Text>
        <Text style={s.stateSub}>Heading to your booking…</Text>
      </Animated.View>
    </SafeAreaView>
  );
}

// ── Styles (theme-aware via useC) ────────────────────────────────────────────
function makeStyles(c: ScreenColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    container: { flex: 1, paddingHorizontal: 20, paddingBottom: 12 },

    topbar: { height: 48, justifyContent: 'center' },
    iconBtn: {
      width: 36, height: 36, borderRadius: 12,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.glass,
      borderWidth: 1, borderColor: c.glassBorderHi,
    },

    hero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    ringField: {
      width: HERO, height: HERO,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: 24,
    },
    ring: {
      position: 'absolute',
      width: RING_BASE, height: RING_BASE, borderRadius: RING_BASE / 2,
      borderWidth: 1.5, borderColor: c.amber,
    },
    title: {
      fontFamily: FontFamily.extrabold,
      fontSize: 26,
      color: c.text,
      letterSpacing: -0.6,
      textAlign: 'center',
    },
    subtitle: {
      fontFamily: FontFamily.medium,
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
      marginTop: 8,
      lineHeight: 20,
      maxWidth: 280,
    },
    completion: {
      width: 240, height: 5, borderRadius: 999,
      backgroundColor: c.glass,
      overflow: 'hidden',
      marginTop: 22,
    },
    fill: {
      height: '100%', borderRadius: 999,
      backgroundColor: c.amber,
    },
    fillWarn: { backgroundColor: c.amberLo },
    shimmer: {
      position: 'absolute', top: 0, bottom: 0,
      width: 60, borderRadius: 999,
      backgroundColor: c.amberHi,
      opacity: 0.55,
    },

    summary: {
      borderRadius: 18, padding: 16,
      backgroundColor: c.glass,
      borderWidth: 1, borderColor: c.glassBorder,
      marginTop: 8,
    },
    summaryTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    svcIcon: {
      width: 48, height: 48, borderRadius: 13,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.glassHi,
      borderWidth: 1, borderColor: c.glassBorder,
      overflow: 'hidden',
    },
    svcImg: { width: 30, height: 30 },
    svcMeta: { flex: 1, minWidth: 0 },
    svcName: {
      fontFamily: FontFamily.bold,
      fontSize: 16,
      color: c.text,
      letterSpacing: -0.2,
    },
    price: {
      paddingHorizontal: 10, paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: c.amberSoft,
    },
    priceText: {
      fontFamily: FontFamily.bold,
      fontSize: 12,
      color: c.amber,
      letterSpacing: -0.1,
    },
    divider: { height: 1, backgroundColor: c.divider, marginVertical: 13, marginHorizontal: -16 },
    addrRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    pin: {
      width: 30, height: 30, borderRadius: 9,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.amberSoft,
    },
    addr: { flex: 1, minWidth: 0 },
    addrLabel: {
      fontFamily: FontFamily.bold,
      fontSize: 10,
      color: c.textMuted,
      letterSpacing: 1.2,
    },
    addrVal: {
      fontFamily: FontFamily.semibold,
      fontSize: 13,
      color: c.text,
      marginTop: 1,
    },

    cancelRow: { alignItems: 'center', gap: 6, marginTop: 18 },
    switchText: {
      fontFamily: FontFamily.semibold,
      fontSize: 14,
      color: c.amber,
      paddingVertical: 8,
    },
    ghostText: {
      fontFamily: FontFamily.semibold,
      fontSize: 14,
      color: c.textMuted,
      paddingVertical: 8,
    },

    // shared terminal-state styles
    stateContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
    stateIcon: {
      width: 96, height: 96, borderRadius: 28,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.glass,
      borderWidth: 1, borderColor: c.glassBorder,
      marginBottom: 26,
    },
    stateSub: {
      fontFamily: FontFamily.regular,
      fontSize: 14.5,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
      marginTop: 10,
      marginBottom: 30,
      maxWidth: 300,
    },
    retryBtn: {
      backgroundColor: c.amber,
      borderRadius: 999,
      paddingVertical: 16, paddingHorizontal: 48,
      marginBottom: 10,
    },
    retryBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: 15,
      color: c.ink,
      letterSpacing: 0.3,
    },
    secondaryBtn: {
      borderRadius: 999,
      paddingVertical: 14, paddingHorizontal: 44,
      marginBottom: 10,
      borderWidth: 1, borderColor: c.glassBorderHi,
      backgroundColor: c.glassHi,
    },
    secondaryBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: 14,
      color: c.text,
      letterSpacing: 0.2,
    },
    backBtn: { paddingVertical: 12, paddingHorizontal: 32 },
  });
}
