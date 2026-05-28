// ActiveBookingPill — Phase 1 Step 5b — home-screen "live booking" pill.
//
// Appears when a customer has a live booking (pro is en route, has
// arrived, or service is in progress). Tapping it opens TrackLive for
// the most-advanced live booking. Drops automatically when the booking
// hits a terminal state (completed / cancelled) — derived from the
// status field returned by the existing GetCustomerBookings list
// payload (Step 5b backend commit adds the lifecycle timestamps).
//
// Three copy variants depending on the booking's substate:
//
//   accepted + en_route_at && !arrived_at  → "Your pro is on the way"
//   accepted + arrived_at                   → "Your pro has arrived"
//   in_progress                              → "Service in progress"
//
// Multi-active resolution: customers can hold up to N concurrent active
// bookings depending on backend config (booking.max_active_per_customer,
// defaults 1 — but Roomies / future flows could raise it). The pill
// picks the most-advanced live booking deterministically; ties broken
// by the relevant lifecycle timestamp (most recent wins):
//
//   1. in_progress  → tiebreak started_at DESC
//   2. arrived_at    → tiebreak arrived_at DESC
//   3. en_route_at  → tiebreak en_route_at DESC
//
// Mutual exclusion with UpcomingBookingIndicator: that component already
// renders for pending/accepted bookings; we filter out anything that
// satisfies the pill's narrower criteria there (see modified
// UpcomingBookingIndicator in this commit). Net: customer sees the pill
// that matches the most-relevant state, never two stacked indicators.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { useColors } from '../../context/ThemeContext';
import { getBookings, type ApiBooking } from '../../api/bookings';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';

type Nav = NativeStackNavigationProp<MainStackParamList>;

// LiveSubstate — the substate the pill renders for. Matches the
// derivation in TrackLiveScreen / docs/phase-1-payment-gated-flow.md.
type LiveSubstate = 'en_route' | 'arrived' | 'in_progress';

// pickLiveBooking returns the most-advanced live booking from the
// supplied list, or null if none. Pure function so it's trivially
// testable + reasoning-friendly. The substate is returned alongside
// the booking so the caller doesn't recompute.
export function pickLiveBooking(list: ApiBooking[]): { booking: ApiBooking; substate: LiveSubstate } | null {
  let best: { booking: ApiBooking; substate: LiveSubstate; rank: number; ts: number } | null = null;
  for (const b of list) {
    let substate: LiveSubstate | null = null;
    let rank = 0;
    let ts = 0;

    if (b.status === 'in_progress') {
      substate = 'in_progress';
      rank = 3;
      ts = b.started_at ? Date.parse(b.started_at) : Date.parse(b.created_at);
    } else if (b.status === 'accepted' && b.arrived_at) {
      substate = 'arrived';
      rank = 2;
      ts = Date.parse(b.arrived_at);
    } else if (b.status === 'accepted' && b.en_route_at) {
      substate = 'en_route';
      rank = 1;
      ts = Date.parse(b.en_route_at);
    }

    if (substate === null) continue;
    if (best === null || rank > best.rank || (rank === best.rank && ts > best.ts)) {
      best = { booking: b, substate, rank, ts };
    }
  }
  return best === null ? null : { booking: best.booking, substate: best.substate };
}

// COPY_BY_SUBSTATE — single source of truth for the pill's wording.
const COPY_BY_SUBSTATE: Record<LiveSubstate, string> = {
  en_route: 'Your pro is on the way',
  arrived: 'Your pro has arrived',
  in_progress: 'Service in progress',
};

export default function ActiveBookingPill() {
  const navigation = useNavigation<Nav>();
  const { token } = useAuth();
  const c = useColors();
  const [live, setLive] = useState<{ booking: ApiBooking; substate: LiveSubstate } | null>(null);
  const [opacity] = useState(new Animated.Value(0));

  const fetchLive = useCallback(async () => {
    if (!token) return;
    try {
      const list = await getBookings(token, 'upcoming');
      const next = pickLiveBooking(list);
      setLive(next);
      Animated.timing(opacity, {
        toValue: next ? 1 : 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } catch {
      // Network blip — keep showing the previous state. Next 30s
      // tick or focus-effect refetch will recover.
    }
  }, [token, opacity]);

  // Refetch on every focus (e.g. after TrackLive back-nav, after a
  // booking transitions to completed/cancelled).
  useFocusEffect(useCallback(() => { fetchLive(); }, [fetchLive]));

  // 30s tick mirrors UpcomingBookingIndicator's cadence. The real-time
  // signal would be FCM booking_status_change, but the existing pill
  // surfaces don't subscribe and polling is the safe baseline.
  useEffect(() => {
    const id = setInterval(fetchLive, 30_000);
    return () => clearInterval(id);
  }, [fetchLive]);

  const styles = useMemo(() => createStyles(c), [c]);

  if (!live) return null;

  return (
    <Animated.View style={[styles.wrapper, { opacity }]} pointerEvents="box-none">
      <TouchableOpacity
        style={styles.pill}
        activeOpacity={0.85}
        onPress={() => {
          // ActiveBooking expects rich initial-render params; TrackLive
          // refetches the full detail on mount so these are just
          // for the first paint. Pass what's on the list payload;
          // default the rest. The screen has its own loading state
          // when the fields are empty.
          const b = live.booking;
          const firstService = b.services?.[0];
          navigation.navigate('ActiveBooking', {
            bookingId: b.id,
            serviceName: firstService?.service_name ?? 'Service',
            helperName: b.helper_name ?? '',
            helperRating: b.helper_rating ?? 0,
            helperLat: b.helper_lat,
            helperLng: b.helper_lng,
            etaMinutes: 0,
          });
        }}
        accessibilityRole="button"
        accessibilityLabel={`${COPY_BY_SUBSTATE[live.substate]}. Tap to open live tracking.`}
      >
        <PulseDot />
        <Text style={styles.text} numberOfLines={1}>
          {COPY_BY_SUBSTATE[live.substate]}
        </Text>
        <Feather name="chevron-right" size={16} color="rgba(13,13,15,0.6)" />
      </TouchableOpacity>
    </Animated.View>
  );
}

// PulseDot — single 8px green dot pulsing in place. Mirrors the
// LivePill dot animation but smaller and color-stable (no PulseDot
// import to keep this self-contained).
function PulseDot() {
  const [pulse] = useState(new Animated.Value(1));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[pulseStyles.dot, { opacity: pulse }]} />;
}

const pulseStyles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22C55E',
    shadowColor: '#22C55E',
    shadowOpacity: 0.8,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
});

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    wrapper: {
      position: 'absolute',
      // Floats above the bottom-tab area (96px) by a safe margin —
      // matches UpcomingBookingIndicator's positioning so the two
      // never visually conflict; mutual exclusion is enforced by
      // each component's null-return path.
      bottom: Platform.select({ ios: 110, android: 100 }),
      alignSelf: 'center',
      zIndex: 10,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: '#F5A300',
      paddingHorizontal: 18,
      paddingVertical: 12,
      borderRadius: Radius.full,
      ...Shadow.md,
      maxWidth: 320,
    },
    text: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.sm,
      color: '#0D0D0F',
      letterSpacing: -0.1,
    },
  });
}
