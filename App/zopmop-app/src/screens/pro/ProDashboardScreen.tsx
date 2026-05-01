import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Alert,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList } from '../../types/navigation';
import * as Location from 'expo-location';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Radius, Shadow, Spacing } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { getHelperInvitesWithDetails } from '../../api/matching';
import { apiFetch } from '../../api/client';
import { BASE_URL } from '../../api/config';

export default function ProDashboardScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token, user, signOut } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  // On mount: if there's an active booking, go straight to ProActive.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    (async () => {
      try {
        const res = await apiFetch(`${BASE_URL}/bookings?status=upcoming`, {
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
      } catch { /* silently ignore */ }
    })();
  }, [token]);

  const [isOnline, setIsOnline] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [checkingInvites, setCheckingInvites] = useState(false);
  const [inviteCount, setInviteCount] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigatingToBookingRef = useRef(false);

  // Pulse ring for GO ONLINE button
  const ringScale = useRef(new Animated.Value(1)).current;
  const ringOpacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    if (isOnline) {
      Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(ringScale, { toValue: 1.35, duration: 1000, useNativeDriver: true }),
            Animated.timing(ringScale, { toValue: 1, duration: 1000, useNativeDriver: true }),
          ]),
          Animated.sequence([
            Animated.timing(ringOpacity, { toValue: 0, duration: 1000, useNativeDriver: true }),
            Animated.timing(ringOpacity, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
          ]),
        ])
      ).start();
    } else {
      ringScale.stopAnimation(); ringScale.setValue(1);
      ringOpacity.stopAnimation(); ringOpacity.setValue(0.4);
    }
  }, [isOnline]);

  const checkInvites = useCallback(async () => {
    if (!token || token === '__guest__') return;
    if (navigatingToBookingRef.current) return;
    setCheckingInvites(true);
    try {
      const invites = await getHelperInvitesWithDetails(token);
      setInviteCount(invites.length);
      if (invites.length > 0 && !navigatingToBookingRef.current) {
        navigatingToBookingRef.current = true;
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        const invite = invites[0];
        navigation.navigate('ProMatched', {
          bookingId: invite.booking_id.trim(),
          serviceName: invite.services?.[0] ?? 'Home Service',
          customerAddress: invite.address || 'Customer Location',
          customerLat: invite.lat,
          customerLng: invite.lng,
        });
      }
    } catch {
      // retry on next cycle
    } finally {
      setCheckingInvites(false);
    }
  }, [token]);

  useEffect(() => {
    navigatingToBookingRef.current = false;
    if (isOnline) {
      checkInvites();
      pollRef.current = setInterval(checkInvites, 8000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
      setInviteCount(0);
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
      await apiFetch(`${BASE_URL}/helpers/me/location`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function handleToggle() {
    if (toggling) return;
    setToggling(true);
    try {
      if (!isOnline) {
        const ok = await pushLocation();
        if (!ok) {
          Alert.alert('Location needed', 'Enable location permission to go online.');
          return;
        }
        // Guard: clear any pre-existing interval before assigning a new one
        // (prevents stacking if state ever desyncs with the ref).
        if (locationHeartbeatRef.current) {
          clearInterval(locationHeartbeatRef.current);
          locationHeartbeatRef.current = null;
        }
        locationHeartbeatRef.current = setInterval(pushLocation, 2 * 60 * 1000);
        setIsOnline(true);
      } else {
        if (locationHeartbeatRef.current) {
          clearInterval(locationHeartbeatRef.current);
          locationHeartbeatRef.current = null;
        }
        apiFetch(`${BASE_URL}/helpers/me/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ is_available: false }),
        }).catch(() => {});
        setIsOnline(false);
      }
    } finally {
      setToggling(false);
    }
  }

  // Pause the location heartbeat when the app is backgrounded; resume on foreground.
  // This avoids burning battery + uploading stale GPS while the user is away.
  useEffect(() => {
    if (!isOnline) return;
    const sub = AppState.addEventListener('change', (next) => {
      if ((next === 'background' || next === 'inactive') && locationHeartbeatRef.current) {
        clearInterval(locationHeartbeatRef.current);
        locationHeartbeatRef.current = null;
      } else if (next === 'active' && !locationHeartbeatRef.current && isOnline) {
        // Push immediately so backend sees us as fresh, then resume cadence.
        pushLocation();
        locationHeartbeatRef.current = setInterval(pushLocation, 2 * 60 * 1000);
      }
    });
    return () => sub.remove();
  }, [isOnline]);

  function handleSignOut() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  }

  const firstName = user?.name?.split(' ')[0] ?? 'Pro';

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={s.content} bounces={false} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.greeting}>Hey, {firstName} 👋</Text>
            <Text style={s.subGreeting}>Ready to earn today?</Text>
          </View>
          {checkingInvites && <ActivityIndicator size="small" color={c.primary} />}
        </View>

        {/* Stats row */}
        <View style={s.statsRow}>
          <StatCard icon="⭐" label="Rating" value="4.9" />
          <StatCard icon="✅" label="Jobs Done" value="—" />
          <StatCard icon="💰" label="Earned" value="₹—" />
        </View>

        {/* GO ONLINE button */}
        <View style={s.goOnlineSection}>
          <TouchableOpacity
            onPress={handleToggle}
            activeOpacity={0.88}
            disabled={toggling}
            style={s.goOnlineTouchable}
          >
            <View style={s.goOnlineOuter}>
              {isOnline && (
                <Animated.View style={[
                  s.goOnlineRing,
                  { transform: [{ scale: ringScale }], opacity: ringOpacity },
                ]} />
              )}
              <View style={[s.goOnlineBtn, isOnline && s.goOnlineBtnActive]}>
                {toggling
                  ? <ActivityIndicator color={isOnline ? '#FFFFFF' : c.primary} size="large" />
                  : <Text style={s.goOnlineEmoji}>{isOnline ? '🟢' : '⚫'}</Text>
                }
                <Text style={[s.goOnlineLabel, isOnline && { color: '#FFFFFF' }]}>
                  {isOnline ? 'YOU\'RE LIVE' : 'GO ONLINE'}
                </Text>
                <Text style={[s.goOnlineSub, isOnline && { color: 'rgba(255,255,255,0.75)' }]}>
                  {isOnline ? 'Tap to go offline' : 'Tap to start earning'}
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          {isOnline && (
            <View style={s.scanningRow}>
              <View style={s.scanningDot} />
              <Text style={s.scanningText}>
                {inviteCount > 0
                  ? `${inviteCount} booking invite${inviteCount > 1 ? 's' : ''} waiting!`
                  : 'Scanning for nearby bookings…'
                }
              </Text>
            </View>
          )}
        </View>

        {/* How it works */}
        <View style={s.howCard}>
          <Text style={s.howTitle}>How ZopMop works</Text>
          <View style={s.howSteps}>
            <HowStep n="1" text="Go online — we find customers near you" />
            <HowStep n="2" text="Accept a booking invite when it appears" />
            <HowStep n="3" text="Complete the job and get rated" />
          </View>
        </View>

        {/* Sign out */}
        <TouchableOpacity style={s.signOutBtn} onPress={handleSignOut} activeOpacity={0.7}>
          <Text style={s.signOutText}>Sign Out</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.statCard}>
      <Text style={s.statIcon}>{icon}</Text>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function HowStep({ n, text }: { n: string; text: string }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.howStep}>
      <View style={s.howStepNum}><Text style={s.howStepNumText}>{n}</Text></View>
      <Text style={s.howStepText}>{text}</Text>
    </View>
  );
}

const BUTTON_SIZE = 164;

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    content: { padding: 20, gap: 20, paddingBottom: 40 },

    header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
    greeting: { fontFamily: FontFamily.extrabold, fontSize: FontSize['2xl'], color: c.text, letterSpacing: -0.5 },
    subGreeting: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textMuted, marginTop: 2 },

    statsRow: { flexDirection: 'row', gap: 10 },
    statCard: {
      flex: 1, backgroundColor: c.white,
      borderRadius: Radius.xl, padding: 14,
      alignItems: 'center', gap: 4,
      borderWidth: 1, borderColor: c.border,
      ...Shadow.sm,
    },
    statIcon: { fontSize: 20 },
    statValue: { fontFamily: FontFamily.extrabold, fontSize: FontSize.lg, color: c.text },
    statLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },

    goOnlineSection: { alignItems: 'center', gap: 16, paddingVertical: 8 },
    goOnlineTouchable: { alignItems: 'center' },
    goOnlineOuter: { width: BUTTON_SIZE + 40, height: BUTTON_SIZE + 40, alignItems: 'center', justifyContent: 'center' },
    goOnlineRing: {
      position: 'absolute',
      width: BUTTON_SIZE + 32,
      height: BUTTON_SIZE + 32,
      borderRadius: (BUTTON_SIZE + 32) / 2,
      backgroundColor: c.primary,
    },
    goOnlineBtn: {
      width: BUTTON_SIZE, height: BUTTON_SIZE,
      borderRadius: BUTTON_SIZE / 2,
      backgroundColor: c.surface,
      borderWidth: 3, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
      gap: 4,
      ...Shadow.lg,
    },
    goOnlineBtnActive: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    goOnlineEmoji: { fontSize: 36 },
    goOnlineLabel: { fontFamily: FontFamily.extrabold, fontSize: FontSize.base, color: c.text, letterSpacing: 0.5 },
    goOnlineSub: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: c.textMuted },

    scanningRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    scanningDot: { width: 8, height: 8, borderRadius: Radius.full, backgroundColor: c.success },
    scanningText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.success },

    howCard: {
      backgroundColor: c.white, borderRadius: Radius.xl,
      padding: 20, borderWidth: 1, borderColor: c.border, gap: 14, ...Shadow.sm,
    },
    howTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: c.text },
    howSteps: { gap: 12 },
    howStep: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    howStepNum: {
      width: 28, height: 28, borderRadius: Radius.full,
      backgroundColor: c.primaryBg,
      alignItems: 'center', justifyContent: 'center',
    },
    howStepNumText: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: c.primary },
    howStepText: { flex: 1, fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: c.textSecondary, lineHeight: 20 },

    signOutBtn: {
      alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10,
      borderRadius: Radius.full,
      borderWidth: 1, borderColor: c.border,
      backgroundColor: c.white,
    },
    signOutText: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: c.textMuted },
  });
}
