import React, { useCallback, useEffect, useState } from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  Animated,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../types/navigation';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../theme';
import { getBookings, type ApiBooking } from '../api/bookings';
import { useAuth } from '../context/AuthContext';
import { onShiftEvent } from '../utils/shiftEvents';

type Nav = NativeStackNavigationProp<MainStackParamList>;

export default function UpcomingBookingIndicator() {
  const navigation = useNavigation<Nav>();
  const { token } = useAuth();
  const [booking, setBooking] = useState<ApiBooking | null>(null);
  const [opacity] = useState(new Animated.Value(0));

  const fetchUpcoming = useCallback(async () => {
    if (!token) return;
    try {
      const list = await getBookings(token, 'upcoming');
      // Phase 1 Step 5b mutual exclusion: skip bookings that the new
      // ActiveBookingPill is showing — anything with en_route_at set
      // (the pro is in transit / arrived / service started). Without
      // this filter the customer would see two pills stacked at the
      // bottom of HomeScreen.
      const next = list.find(b =>
        (b.status === 'pending' || b.status === 'accepted') && !b.en_route_at,
      ) ?? null;
      setBooking(next);
      Animated.timing(opacity, {
        toValue: next ? 1 : 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } catch {
      setBooking(null);
    }
  }, [token, opacity]);

  // Refetch immediately whenever the screen comes into focus (e.g. after cancellation)
  useFocusEffect(useCallback(() => {
    fetchUpcoming();
  }, [fetchUpcoming]));

  useEffect(() => {
    const interval = setInterval(fetchUpcoming, 30_000);
    return () => clearInterval(interval);
  }, [fetchUpcoming]);

  // Phase 1 Step 5b.1 — react to FCM booking_status_change like
  // ActiveBookingPill does, so the handoff between the two pills at
  // en_route_at != null happens in the same JS tick. Without this,
  // the 30s polls drift independently and the customer can see a
  // brief two-pill / zero-pill flash.
  useEffect(() => {
    return onShiftEvent((ev) => {
      if (ev.type === 'booking_status_change') {
        fetchUpcoming();
      }
    });
  }, [fetchUpcoming]);

  if (!booking) return null;

  const label = booking.scheduled_time
    ? formatTime(booking.scheduled_time)
    : 'Today';

  const serviceNames = booking.services?.length
    ? booking.services.map(s => s.service_name).join(', ')
    : 'Service';

  return (
    <Animated.View style={[s.wrapper, { opacity }]}>
      <TouchableOpacity
        style={s.pill}
        activeOpacity={0.85}
        onPress={() => navigation.navigate('Bookings')}
      >
        <Text style={s.dot}>●</Text>
        <Text style={s.text} numberOfLines={1}>
          Upcoming: {serviceNames} · {label}
        </Text>
        <Text style={s.arrow}>›</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-IN', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const s = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 32,
    alignSelf: 'center',
    zIndex: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radius.full,
    ...Shadow.md,
    maxWidth: 300,
  },
  dot: { fontSize: 8, color: '#4ADE80' },
  text: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.xs,
    color: Colors.white,
    flex: 1,
  },
  arrow: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.7)',
  },
});
