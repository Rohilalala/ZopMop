import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
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
import { C } from '../../theme/screen';
import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { useAuth } from '../../context/AuthContext';
import { createInstantBooking, getMatchStatus } from '../../api/matching';
import { apiFetch } from '../../api/client';
import { BASE_URL } from '../../api/config';
import { showError } from '../../utils/toast';

const { width: W } = Dimensions.get('window');

const MATCH_DURATION = 30000;
const PHASES = [
  { at: 0,    label: 'Finding available pros near you…' },
  { at: 0.35, label: 'Checking availability & ratings…' },
  { at: 0.65, label: 'Almost there — locking in your pro…' },
  { at: 0.88, label: 'Finalising match…' },
];

type ScreenState = 'searching' | 'busy' | 'matched';

type Props = {
  route: RouteProp<MainStackParamList, 'InstantMatching'>;
};

export default function InstantMatchingScreen({ route }: Props) {
  const { serviceId, serviceName } = route.params;
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();

  const [screenState, setScreenState] = useState<ScreenState>('searching');
  const [phaseIdx, setPhaseIdx] = useState(0);

  const progress = useRef(new Animated.Value(0)).current;
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  const bookingIdRef = useRef<string | null>(null);
  const priceCentsRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    function bounce(val: Animated.Value, delay: number) {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: -8, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 320, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay(400),
        ]),
      );
    }
    const a1 = bounce(dot1, 0);
    const a2 = bounce(dot2, 160);
    const a3 = bounce(dot3, 320);
    a1.start(); a2.start(); a3.start();

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    pulseLoop.start();

    return () => {
      a1.stop(); a2.stop(); a3.stop();
      pulseLoop.stop();
    };
  }, []);

  useEffect(() => {
    const timers = PHASES.slice(1).map((p, i) =>
      setTimeout(() => setPhaseIdx(i + 1), p.at * MATCH_DURATION),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    let cancelled = false;
    const safeTimeout = (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      pendingTimers.current.push(id);
      return id;
    };

    async function run() {
      Animated.timing(progress, {
        toValue: 1,
        duration: MATCH_DURATION,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: false,
      }).start();

      timeoutRef.current = safeTimeout(() => {
        if (cancelled || matchedRef.current) return;
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        progress.stopAnimation();
        const bid = bookingIdRef.current;
        if (bid && token && token !== '__guest__') {
          apiFetch(`${BASE_URL}/bookings/${bid}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          }).catch(() => {});
        }
        setScreenState('busy');
      }, MATCH_DURATION);

      if (!token || token === '__guest__') {
        safeTimeout(() => { if (!cancelled) setScreenState('busy'); }, MATCH_DURATION);
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
            navigation.goBack();
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
            navigation.goBack();
          }
          return;
        }

        const booking = await createInstantBooking(
          token,
          serviceId,
          'User Location',
          lat,
          lng,
        );
        bookingId = booking.id;
        bookingIdRef.current = bookingId;
        priceCentsRef.current = booking.price_cents ?? 0;
      } catch {
        return;
      }

      pollRef.current = setInterval(async () => {
        if (!bookingId || cancelled) return;
        try {
          const status = await getMatchStatus(token, bookingId);
          if (status.status === 'matched' && status.helper) {
            matchedRef.current = true;
            matchedHelperRef.current = {
              name: status.helper.name || 'Your Pro',
              phone: status.helper.phone || '',
              rating: status.helper.rating,
              lat: status.helper.lat ?? 0,
              lng: status.helper.lng ?? 0,
              eta_minutes: status.helper.eta_minutes,
            };
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
            progress.stopAnimation();
            if (!cancelled && !userCancelledRef.current) {
              navigation.replace('BookingConfirmed', {
                bookingId: bookingId!,
                totalCents: priceCentsRef.current,
                serviceId,
                serviceName,
                helperName: status.helper.name || 'Your Pro',
                helperPhone: status.helper.phone,
                helperRating: status.helper.rating,
                instant: true,
              });
            }
          } else if (status.status === 'failed' || (status.status === 'matched' && !status.helper)) {
            if (pollRef.current) clearInterval(pollRef.current);
            if (!cancelled) { progress.stopAnimation(); setScreenState('busy'); }
          }
        } catch { /* network — keep polling */ }
      }, 3000);
    }

    run();
    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      pendingTimers.current.forEach(clearTimeout);
      pendingTimers.current = [];
      const bid = bookingIdRef.current;
      if (bid && !matchedRef.current && token && token !== '__guest__') {
        apiFetch(`${BASE_URL}/bookings/${bid}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    };
  }, []);

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
                instant: true,
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
      navigation.goBack();
    }
  }

  const progressWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });

  if (screenState === 'busy') {
    return <BusyScreen onRetry={() => navigation.goBack()} onBack={() => navigation.goBack()} />;
  }

  if (screenState === 'matched') {
    return <MatchedFlash />;
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Bloom />
      <View style={s.container}>

        <View style={s.iconArea}>
          <View style={s.iconWrap}>
            <Animated.View
              pointerEvents="none"
              style={[
                s.pulseRing,
                { transform: [{ scale: pulseScale }], opacity: pulseOpacity },
              ]}
            />
            <GlassCard radius={64} hero style={s.iconCircle}>
              <Feather name="zap" size={44} color={C.amber} />
            </GlassCard>
          </View>
          <View style={s.dotsRow}>
            {[dot1, dot2, dot3].map((d, i) => (
              <Animated.View key={i} style={[s.dot, { transform: [{ translateY: d }] }]} />
            ))}
          </View>
        </View>

        <Text style={s.title}>Finding your Pro</Text>
        <Text style={s.phaseLabel}>{PHASES[phaseIdx].label}</Text>

        <View style={s.serviceChip}>
          <Text style={s.serviceChipText}>{serviceName}</Text>
        </View>

        <View style={s.progressTrack}>
          <Animated.View style={[s.progressFill, { width: progressWidth }]} />
        </View>

        <Text style={s.progressHint}>Usually takes less than 30 seconds</Text>

        <TouchableOpacity style={s.cancelBtn} activeOpacity={0.7} onPress={handleCancel}>
          <Text style={s.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function BusyScreen({ onRetry, onBack }: { onRetry: () => void; onBack: () => void }) {
  const fadeIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, []);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Bloom />
      <Animated.View style={[s.container, { opacity: fadeIn }]}>
        <GlassCard radius={64} hero style={s.iconCircle}>
          <Feather name="clock" size={44} color={C.amber} />
        </GlassCard>
        <View style={{ height: 28 }} />
        <Text style={s.title}>All our pros are busy</Text>
        <Text style={s.busySub}>
          Our professionals are all on jobs right now. Please try again in a few minutes.
        </Text>
        <TouchableOpacity style={s.retryBtn} activeOpacity={0.88} onPress={onRetry}>
          <Text style={s.retryBtnText}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.backBtn} activeOpacity={0.7} onPress={onBack}>
          <Text style={s.backBtnText}>Go Back</Text>
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView>
  );
}

function MatchedFlash() {
  const scale = useRef(new Animated.Value(0.4)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 14 }),
      Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Bloom />
      <Animated.View style={[s.container, { opacity }]}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <GlassCard radius={64} hero style={s.iconCircle}>
            <Feather name="check" size={48} color={C.green} />
          </GlassCard>
        </Animated.View>
        <View style={{ height: 28 }} />
        <Text style={[s.title, { color: C.green }]}>Pro Matched</Text>
        <Text style={s.busySub}>Heading to your booking…</Text>
      </Animated.View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },

  iconArea: { alignItems: 'center', marginBottom: 32 },
  iconWrap: {
    width: 128, height: 128,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 22,
  },
  iconCircle: {
    width: 128, height: 128,
    alignItems: 'center', justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 128, height: 128, borderRadius: 64,
    borderWidth: 1.5, borderColor: C.amberLine,
  },
  dotsRow: { flexDirection: 'row', gap: 10 },
  dot: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: C.amber,
  },

  title: {
    fontFamily: FontFamily.extrabold,
    fontSize: 26,
    color: C.white,
    letterSpacing: -0.6,
    marginBottom: 10,
    textAlign: 'center',
  },
  phaseLabel: {
    fontFamily: FontFamily.regular,
    fontSize: 14.5,
    color: C.textSecondary,
    textAlign: 'center',
    marginBottom: 22,
    lineHeight: 22,
    minHeight: 44,
  },
  serviceChip: {
    backgroundColor: C.amberSoft,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: C.amberLine,
    marginBottom: 30,
  },
  serviceChipText: {
    fontFamily: FontFamily.semibold,
    fontSize: 13.5,
    color: C.amber,
    letterSpacing: 0.2,
  },

  progressTrack: {
    width: '100%',
    height: 8,
    backgroundColor: C.glass,
    borderRadius: 999,
    overflow: 'hidden',
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: C.glassBorder,
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: C.amber,
  },
  progressHint: {
    fontFamily: FontFamily.regular,
    fontSize: 12,
    color: C.textMuted,
    marginBottom: 36,
  },

  cancelBtn: {
    paddingVertical: 13,
    paddingHorizontal: 36,
    borderRadius: 999,
    borderWidth: 0.5,
    borderColor: C.glassBorderHi,
    backgroundColor: C.glassHi,
  },
  cancelText: {
    fontFamily: FontFamily.semibold,
    fontSize: 14,
    color: C.white,
    letterSpacing: 0.2,
  },

  busySub: {
    fontFamily: FontFamily.regular,
    fontSize: 14.5,
    color: C.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
    maxWidth: 300,
  },
  retryBtn: {
    backgroundColor: C.amber,
    borderRadius: 999,
    paddingVertical: 16,
    paddingHorizontal: 48,
    marginBottom: 10,
  },
  retryBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: 15,
    color: C.ink,
    letterSpacing: 0.3,
  },
  backBtn: {
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  backBtnText: {
    fontFamily: FontFamily.medium,
    fontSize: 14,
    color: C.textSecondary,
  },
});
