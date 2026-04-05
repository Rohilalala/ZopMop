import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  Dimensions,
  Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import * as Location from 'expo-location';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { createInstantBooking, getMatchStatus } from '../../api/matching';

const { width: W } = Dimensions.get('window');

// How long the loading bar runs (ms)
const MATCH_DURATION = 30000;
// Phase labels
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
  const { token, user } = useAuth();

  const [screenState, setScreenState] = useState<ScreenState>('searching');
  const [phaseIdx, setPhaseIdx] = useState(0);

  // Progress bar animation (0 → 1 over MATCH_DURATION)
  const progress = useRef(new Animated.Value(0)).current;
  // Dots bounce animation
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;
  // Success flash
  const flash = useRef(new Animated.Value(0)).current;

  const bookingIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matchedRef = useRef(false);

  // -- Bounce dots animation
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
  }, []);

  // -- Phase label cycling
  useEffect(() => {
    const timers = PHASES.slice(1).map((p, i) =>
      setTimeout(() => setPhaseIdx(i + 1), p.at * MATCH_DURATION),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  // -- Main effect: start booking + poll for match
  useEffect(() => {
    let cancelled = false;

    async function run() {
      // 1. Start progress bar animation
      Animated.timing(progress, {
        toValue: 1,
        duration: MATCH_DURATION,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: false,
      }).start();

      // Hard stop at exactly 30 s — kill polling, cancel the booking, show busy.
      timeoutRef.current = setTimeout(() => {
        if (cancelled || matchedRef.current) return;
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        progress.stopAnimation();
        // Cancel the booking so the backend stops re-queueing it and
        // helpers' invite sets are cleaned up immediately.
        const bid = bookingIdRef.current;
        if (bid && token && token !== '__guest__') {
          const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';
          fetch(`${BASE_URL}/bookings/${bid}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          }).catch(() => {/* best-effort — batcher will auto-expire it anyway */});
        }
        setScreenState('busy');
      }, MATCH_DURATION);

      // 2. Create the instant booking with a dummy address (we use user's stored location)
      if (!token || token === '__guest__') {
        // Not authenticated — simulate as busy after delay
        setTimeout(() => { if (!cancelled) setScreenState('busy'); }, MATCH_DURATION);
        return;
      }

      let bookingId: string | null = null;
      try {
        // Get real GPS coordinates for matching.
        let lat = 28.4357;
        let lng = 77.0763;
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            lat = pos.coords.latitude;
            lng = pos.coords.longitude;
          }
        } catch {
          // Use fallback if GPS fails — matching will still try but may not find nearby pros
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
      } catch {
        // Can't create booking — show busy after progress completes
        return;
      }

      // 3. Poll match-status every 3s
      pollRef.current = setInterval(async () => {
        if (!bookingId || cancelled) return;
        try {
          const status = await getMatchStatus(token, bookingId);
          if (status.status === 'matched' && status.helper) {
            matchedRef.current = true;
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
            progress.stopAnimation();
            // Flash the bar green
            Animated.sequence([
              Animated.timing(flash, { toValue: 1, duration: 300, useNativeDriver: false }),
            ]).start();
            setTimeout(() => {
              if (!cancelled) {
                setScreenState('matched');
                setTimeout(() => {
                  navigation.replace('ActiveBooking', {
                    bookingId: bookingId!,
                    serviceName,
                    helperName: status.helper!.name || 'Your Pro',
                    helperRating: status.helper!.rating,
                    helperLat: status.helper!.lat,
                    helperLng: status.helper!.lng,
                    etaMinutes: status.helper!.eta_minutes,
                  });
                }, 1200);
              }
            }, 400);
          } else if (status.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            if (!cancelled) { progress.stopAnimation(); setScreenState('busy'); }
          }
        } catch { /* network error — keep polling */ }
      }, 3000);
    }

    run();
    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
  }, []);

  const progressWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const progressColor = flash.interpolate({ inputRange: [0, 1], outputRange: [Colors.primary, Colors.success] });

  // ── Renders ────────────────────────────────────────────────────────────────

  if (screenState === 'busy') {
    return <BusyScreen onRetry={() => navigation.goBack()} onBack={() => navigation.goBack()} />;
  }

  if (screenState === 'matched') {
    return <MatchedFlash />;
  }

  // Searching state
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.container}>

        {/* Animated icon + dots */}
        <View style={s.iconArea}>
          <View style={s.iconCircle}>
            <Text style={s.iconEmoji}>⚡</Text>
          </View>
          <View style={s.dotsRow}>
            {[dot1, dot2, dot3].map((d, i) => (
              <Animated.View key={i} style={[s.dot, { transform: [{ translateY: d }] }]} />
            ))}
          </View>
        </View>

        {/* Phase label */}
        <Text style={s.title}>Finding your Pro</Text>
        <Text style={s.phaseLabel}>{PHASES[phaseIdx].label}</Text>

        {/* Service chip */}
        <View style={s.serviceChip}>
          <Text style={s.serviceChipText}>{serviceName}</Text>
        </View>

        {/* Progress bar */}
        <View style={s.progressTrack}>
          <Animated.View style={[s.progressFill, { width: progressWidth, backgroundColor: progressColor }]} />
        </View>

        <Text style={s.progressHint}>Usually takes less than 30 seconds</Text>

        {/* Cancel */}
        <TouchableOpacity style={s.cancelBtn} activeOpacity={0.7} onPress={() => navigation.goBack()}>
          <Text style={s.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ── Busy Screen ───────────────────────────────────────────────────────────────
function BusyScreen({ onRetry, onBack }: { onRetry: () => void; onBack: () => void }) {
  const fadeIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, []);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Animated.View style={[s.container, { opacity: fadeIn }]}>
        <Text style={s.busyEmoji}>😔</Text>
        <Text style={s.busyTitle}>All our pros are busy</Text>
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

// ── Matched Flash ─────────────────────────────────────────────────────────────
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
    <SafeAreaView style={[s.safe, { backgroundColor: Colors.successBg }]} edges={['top', 'bottom']}>
      <Animated.View style={[s.container, { opacity }]}>
        <Animated.Text style={[s.successEmoji, { transform: [{ scale }] }]}>✅</Animated.Text>
        <Text style={[s.busyTitle, { color: Colors.success }]}>Pro Matched!</Text>
        <Text style={s.busySub}>Heading to your booking…</Text>
      </Animated.View>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },

  iconArea: { alignItems: 'center', marginBottom: 32 },
  iconCircle: {
    width: 110,
    height: 110,
    borderRadius: Radius.full,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: `${Colors.primary}33`,
    marginBottom: 20,
    ...Shadow.md,
  },
  iconEmoji: { fontSize: 52 },
  dotsRow: { flexDirection: 'row', gap: 10 },
  dot: {
    width: 12,
    height: 12,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
  },

  title: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: 10,
    textAlign: 'center',
  },
  phaseLabel: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 24,
    minHeight: 48,
  },
  serviceChip: {
    backgroundColor: Colors.primaryBg,
    borderRadius: Radius.full,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: `${Colors.primary}33`,
    marginBottom: 32,
  },
  serviceChipText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.primary,
  },

  progressTrack: {
    width: '100%',
    height: 10,
    backgroundColor: Colors.border,
    borderRadius: Radius.full,
    overflow: 'hidden',
    marginBottom: 12,
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.full,
  },
  progressHint: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginBottom: 40,
  },

  cancelBtn: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  cancelText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
  },

  // Busy state
  busyEmoji: { fontSize: 72, marginBottom: 24 },
  busyTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: 12,
    textAlign: 'center',
  },
  busySub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: 36,
    maxWidth: 280,
  },
  retryBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    paddingVertical: 18,
    paddingHorizontal: 48,
    marginBottom: 14,
    ...Shadow.md,
  },
  retryBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  backBtn: {
    paddingVertical: 14,
    paddingHorizontal: 32,
  },
  backBtnText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
  },

  // Matched flash
  successEmoji: { fontSize: 80, marginBottom: 24 },
});
