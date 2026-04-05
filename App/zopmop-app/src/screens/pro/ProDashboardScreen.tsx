import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import * as Location from 'expo-location';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { getHelperInvitesWithDetails } from '../../api/matching';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';

export default function ProDashboardScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token, user, signOut } = useAuth();

  // On mount: if there's an active booking already (e.g. app resumed), go straight to ProActive.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}/bookings?status=upcoming`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const bookings: any[] = data.bookings ?? [];
        const active = bookings.find(
          b => b.status === 'accepted' || b.status === 'in_progress',
        );
        if (active) {
          navigation.replace('ProActive', {
            bookingId: active.id,
            serviceName: undefined,
            customerAddress: active.address ?? 'Customer Location',
            customerLat: active.lat ?? 0,
            customerLng: active.lng ?? 0,
          });
        }
      } catch { /* silently ignore — not critical */ }
    })();
  }, [token]);

  const [isOnline, setIsOnline] = useState(false);
  const [checkingInvites, setCheckingInvites] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [inviteCount, setInviteCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigatingToBookingRef = useRef(false);

  // Pulse for the online dot
  const dotPulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (isOnline) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(dotPulse, { toValue: 1.5, duration: 700, useNativeDriver: true }),
          Animated.timing(dotPulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      dotPulse.stopAnimation();
      dotPulse.setValue(1);
    }
  }, [isOnline]);

  // Poll for invites when online
  const checkInvites = useCallback(async () => {
    if (!token || token === '__guest__') return;
    if (navigatingToBookingRef.current) return;
    setCheckingInvites(true);
    try {
      const invites = await getHelperInvitesWithDetails(token);
      setLastChecked(new Date());
      setInviteCount(invites.length);
      if (invites.length > 0 && !navigatingToBookingRef.current) {
        navigatingToBookingRef.current = true;
        // Stop poll immediately so we don't navigate again on the next tick.
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        const invite = invites[0];
        const bookingId = invite.booking_id.trim();
        navigation.navigate('ProMatched', {
          bookingId,
          serviceName: invite.services?.[0] ?? 'Home Service',
          customerAddress: invite.address || 'Customer Location',
          customerLat: invite.lat,
          customerLng: invite.lng,
        });
      }
    } catch {
      // silently fail — retry on next cycle
    } finally {
      setCheckingInvites(false);
    }
  }, [token]);

  useEffect(() => {
    navigatingToBookingRef.current = false;
    if (isOnline) {
      checkInvites();
      pollRef.current = setInterval(checkInvites, 8000); // poll every 8s
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
      setInviteCount(0);
      setLastChecked(null);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (locationHeartbeatRef.current) clearInterval(locationHeartbeatRef.current);
    };
  }, [isOnline, checkInvites]);

  async function pushLocation(): Promise<boolean> {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return false;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await fetch(`${BASE_URL}/helpers/me/location`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function toggleOnline(val: boolean) {
    if (val) {
      const ok = await pushLocation();
      if (!ok) {
        Alert.alert('Location needed', 'Enable location permission to go online.');
        return;
      }
      // Heartbeat every 2 minutes to keep the Redis TTL marker alive.
      locationHeartbeatRef.current = setInterval(pushLocation, 2 * 60 * 1000);
      setIsOnline(true);
    } else {
      if (locationHeartbeatRef.current) clearInterval(locationHeartbeatRef.current);
      // Mark offline in backend.
      fetch(`${BASE_URL}/helpers/me/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ is_available: false }),
      }).catch(() => {});
      setIsOnline(false);
    }
  }

  function handleSignOut() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  }

  const statusColor = isOnline ? Colors.success : Colors.textMuted;
  const statusText = isOnline ? 'Online — Looking for bookings' : 'Offline — Not accepting bookings';

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={s.content} bounces={false}>

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.greeting}>Hey, {user?.name?.split(' ')[0] ?? 'Pro'} 👋</Text>
            <Text style={s.subGreeting}>Welcome to your dashboard</Text>
          </View>
          <TouchableOpacity style={s.signOutBtn} onPress={handleSignOut} activeOpacity={0.8}>
            <Text style={s.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>

        {/* Online Toggle Card */}
        <View style={[s.toggleCard, isOnline && s.toggleCardActive]}>
          <View style={s.toggleLeft}>
            <Animated.View style={[s.onlineDot, { backgroundColor: statusColor, transform: [{ scale: dotPulse }] }]} />
            <View>
              <Text style={[s.toggleTitle, isOnline && s.toggleTitleActive]}>
                {isOnline ? 'You are Online' : 'You are Offline'}
              </Text>
              <Text style={s.toggleSub}>{statusText}</Text>
            </View>
          </View>
          <Switch
            value={isOnline}
            onValueChange={toggleOnline}
            trackColor={{ false: Colors.border, true: `${Colors.success}55` }}
            thumbColor={isOnline ? Colors.success : Colors.textMuted}
            ios_backgroundColor={Colors.border}
          />
        </View>

        {/* Status Panel */}
        {isOnline && (
          <View style={s.statusPanel}>
            <View style={s.statusRow}>
              <Text style={s.statusIcon}>📡</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.statusTitle}>Scanning for nearby bookings…</Text>
                {lastChecked && (
                  <Text style={s.statusSub}>
                    Last checked: {lastChecked.toLocaleTimeString()}
                  </Text>
                )}
              </View>
              {checkingInvites && <ActivityIndicator size="small" color={Colors.primary} />}
            </View>
            {inviteCount > 0 && (
              <View style={s.inviteBadge}>
                <Text style={s.inviteBadgeText}>{inviteCount} booking invite{inviteCount > 1 ? 's' : ''} waiting!</Text>
              </View>
            )}
          </View>
        )}

        {/* Info cards */}
        <View style={s.infoGrid}>
          <InfoCard
            icon="⚡"
            title="How it works"
            body={'Go online and we\'ll auto-match you with nearby customers. You\'ll be notified instantly when there\'s a match.'}
          />
          <InfoCard
            icon="📍"
            title="Location"
            body="Your GPS location is used ONLY for matching. Customers never see your precise coordinates."
          />
          <InfoCard
            icon="⭐"
            title="Ratings"
            body="Complete bookings on time to maintain your rating. A higher rating means more bookings."
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <View style={s.infoCard}>
      <Text style={s.infoCardIcon}>{icon}</Text>
      <Text style={s.infoCardTitle}>{title}</Text>
      <Text style={s.infoCardBody}>{body}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 16, paddingBottom: 40 },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  greeting: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subGreeting: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },
  signOutBtn: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  signOutText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  toggleCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1.5,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  toggleCardActive: {
    borderColor: `${Colors.success}55`,
    backgroundColor: Colors.successBg,
  },
  toggleLeft: { flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 },
  onlineDot: { width: 14, height: 14, borderRadius: Radius.full },
  toggleTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    marginBottom: 2,
  },
  toggleTitleActive: { color: Colors.success },
  toggleSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    maxWidth: 180,
  },

  statusPanel: {
    backgroundColor: Colors.primaryBg,
    borderRadius: Radius.xl,
    padding: 18,
    borderWidth: 1,
    borderColor: `${Colors.primary}22`,
    gap: 12,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusIcon: { fontSize: 26 },
  statusTitle: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.primary,
    marginBottom: 2,
  },
  statusSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  inviteBadge: {
    backgroundColor: Colors.success,
    borderRadius: Radius.full,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  inviteBadgeText: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.sm,
    color: Colors.white,
  },

  infoGrid: { gap: 12 },
  infoCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  infoCardIcon: { fontSize: 30, marginBottom: 10 },
  infoCardTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.text,
    marginBottom: 6,
  },
  infoCardBody: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 22,
  },
});
