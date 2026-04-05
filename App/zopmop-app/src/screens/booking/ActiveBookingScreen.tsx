import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Linking,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Radius, Shadow } from '../../theme';

const ARRIVAL_MINUTES = 30;

type Props = {
  route: RouteProp<MainStackParamList, 'ActiveBooking'>;
};

export default function ActiveBookingScreen({ route }: Props) {
  const { bookingId, serviceName, helperName, helperRating, helperLat, helperLng, etaMinutes } =
    route.params;
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  const totalSeconds = (etaMinutes ?? ARRIVAL_MINUTES) * 60;
  const [secondsLeft, setSecondsLeft] = useState(totalSeconds);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { clearInterval(timerRef.current!); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Pulse ring for the pro icon
  const ring = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(ring, { toValue: 1.25, duration: 900, useNativeDriver: true }),
        Animated.timing(ring, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    ).start();
  }, []);

  function openMaps() {
    if (!helperLat || !helperLng) {
      Alert.alert('No location', 'Pro location not yet available.');
      return;
    }
    Linking.openURL(`https://maps.google.com/?q=${helperLat},${helperLng}`).catch(() =>
      Alert.alert('Could not open Maps'),
    );
  }

  function handleCancel() {
    Alert.alert(
      'Cancel Booking?',
      'Are you sure you want to cancel? Cancellation fees may apply.',
      [
        { text: 'Keep Booking', style: 'cancel' },
        { text: 'Cancel Booking', style: 'destructive', onPress: () => navigation.goBack() },
      ],
    );
  }

  // Format mm:ss
  const mins = Math.floor(secondsLeft / 60).toString().padStart(2, '0');
  const secs = (secondsLeft % 60).toString().padStart(2, '0');
  const arrived = secondsLeft === 0;

  // Progress of countdown (1 → 0 as timer runs)
  const timerProgress = secondsLeft / totalSeconds;
  const progressColor = timerProgress > 0.4 ? Colors.success : timerProgress > 0.15 ? Colors.warning : Colors.danger;

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={s.content} bounces={false}>

        {/* Header */}
        <View style={s.headerRow}>
          <View style={[s.statusBadge, arrived ? s.statusBadgeArrived : s.statusBadgeActive]}>
            <View style={[s.statusDot, { backgroundColor: arrived ? Colors.success : Colors.primary }]} />
            <Text style={[s.statusText, { color: arrived ? Colors.success : Colors.primary }]}>
              {arrived ? 'Pro has arrived!' : 'Booking Active'}
            </Text>
          </View>
          <Text style={s.bookingId}>#{bookingId.slice(0, 8).toUpperCase()}</Text>
        </View>

        {/* Countdown */}
        <View style={s.timerCard}>
          <View style={[s.timerBg]}>
            <View style={[s.timerBgCircle, s.timerBgC1]} />
            <View style={[s.timerBgCircle, s.timerBgC2]} />
          </View>

          {arrived ? (
            <Text style={s.arrivedEmoji}>🎉</Text>
          ) : (
            <Animated.View style={[s.proRing, { transform: [{ scale: ring }], borderColor: `${Colors.white}33` }]} />
          )}

          <Text style={s.timerLabel}>
            {arrived ? 'Your pro is here!' : 'Pro arrives in'}
          </Text>
          {!arrived && (
            <Text style={s.timerValue}>{mins}:{secs}</Text>
          )}

          {/* Mini progress bar */}
          {!arrived && (
            <View style={s.timerBar}>
              <View style={[s.timerBarFill, { width: `${timerProgress * 100}%`, backgroundColor: progressColor }]} />
            </View>
          )}

          <Text style={s.timerSub}>
            {arrived ? 'Open the door and say hi! ✌️' : 'Please be ready at your location'}
          </Text>
        </View>

        {/* Pro details card */}
        <View style={s.proCard}>
          <Text style={s.proCardHeading}>Your Pro</Text>
          <View style={s.proRow}>
            <View style={s.proAvatar}>
              <Text style={s.proAvatarText}>
                {helperName?.charAt(0).toUpperCase() ?? '?'}
              </Text>
            </View>
            <View style={s.proInfo}>
              <Text style={s.proName}>{helperName}</Text>
              <View style={s.proRatingRow}>
                <Text style={s.proRatingStar}>⭐</Text>
                <Text style={s.proRatingValue}>{helperRating?.toFixed(1)}</Text>
                <Text style={s.proRatingLabel}> rating</Text>
              </View>
            </View>
            <View style={s.proRight}>
              <Text style={s.proService}>{serviceName}</Text>
            </View>
          </View>
        </View>

        {/* Maps & status */}
        <TouchableOpacity style={s.mapsBtn} activeOpacity={0.85} onPress={openMaps}>
          <Text style={s.mapsBtnIcon}>🗺️</Text>
          <View>
            <Text style={s.mapsBtnTitle}>Track on Google Maps</Text>
            <Text style={s.mapsBtnSub}>See your pro's live location</Text>
          </View>
          <Text style={s.mapsBtnArrow}>→</Text>
        </TouchableOpacity>

        <View style={s.statusCard}>
          <StatusStep done icon="✅" label="Booking confirmed" />
          <StatusStep done={!arrived} active={!arrived} icon="🚗" label="Pro on the way" />
          <StatusStep icon="🏠" label="Pro arrives" active={arrived} done={arrived} />
          <StatusStep icon="✨" label="Service complete" />
        </View>

        {/* Cancel */}
        {!arrived && (
          <TouchableOpacity style={s.cancelBtn} activeOpacity={0.75} onPress={handleCancel}>
            <Text style={s.cancelBtnText}>Cancel Booking</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusStep({ icon, label, done, active }: { icon: string; label: string; done?: boolean; active?: boolean }) {
  return (
    <View style={s.statusStep}>
      <View style={[s.statusStepIcon, done && s.statusStepIconDone, active && !done && s.statusStepIconActive]}>
        <Text style={{ fontSize: done ? 16 : 13, opacity: done || active ? 1 : 0.35 }}>{icon}</Text>
      </View>
      <Text style={[s.statusStepLabel, (done || active) && s.statusStepLabelActive]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, paddingBottom: 40, gap: 16 },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  statusBadgeActive: { borderColor: `${Colors.primary}44`, backgroundColor: Colors.primaryBg },
  statusBadgeArrived: { borderColor: `${Colors.success}44`, backgroundColor: Colors.successBg },
  statusDot: { width: 8, height: 8, borderRadius: Radius.full },
  statusText: { fontFamily: FontFamily.semibold, fontSize: FontSize.sm },
  bookingId: { fontFamily: FontFamily.regular, fontSize: FontSize.xs, color: Colors.textMuted },

  // Timer card
  timerCard: {
    backgroundColor: Colors.primary,
    borderRadius: Radius['2xl'],
    padding: 32,
    alignItems: 'center',
    overflow: 'hidden',
    position: 'relative',
    gap: 8,
  },
  timerBg: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  timerBgCircle: { position: 'absolute', borderRadius: Radius.full, backgroundColor: Colors.white },
  timerBgC1: { width: 180, height: 180, opacity: 0.05, top: -70, right: -50 },
  timerBgC2: { width: 100, height: 100, opacity: 0.04, bottom: -30, left: 40 },
  proRing: {
    position: 'absolute',
    top: 24,
    width: 60,
    height: 60,
    borderRadius: Radius.full,
    borderWidth: 2,
  },
  arrivedEmoji: { fontSize: 52, marginBottom: 8 },
  timerLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.75)',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  timerValue: {
    fontFamily: FontFamily.extrabold,
    fontSize: 68,
    color: Colors.white,
    letterSpacing: -2,
    lineHeight: 76,
  },
  timerBar: {
    width: '85%',
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: Radius.full,
    overflow: 'hidden',
    marginTop: 4,
  },
  timerBarFill: { height: '100%', borderRadius: Radius.full },
  timerSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: 'rgba(255,255,255,0.65)',
    marginTop: 6,
    textAlign: 'center',
  },

  // Pro card
  proCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  proCardHeading: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.textMuted,
    marginBottom: 14,
  },
  proRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  proAvatar: {
    width: 56,
    height: 56,
    borderRadius: Radius.full,
    backgroundColor: Colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: `${Colors.primary}22`,
  },
  proAvatarText: { fontFamily: FontFamily.extrabold, fontSize: FontSize.xl, color: Colors.primary },
  proInfo: { flex: 1 },
  proName: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    marginBottom: 4,
  },
  proRatingRow: { flexDirection: 'row', alignItems: 'center' },
  proRatingStar: { fontSize: FontSize.sm },
  proRatingValue: { fontFamily: FontFamily.bold, fontSize: FontSize.sm, color: Colors.text, marginLeft: 2 },
  proRatingLabel: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textMuted },
  proRight: { alignItems: 'flex-end' },
  proService: { fontFamily: FontFamily.medium, fontSize: FontSize.sm, color: Colors.primary },

  // Maps button
  mapsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.accent,
    padding: 18,
    gap: 14,
    ...Shadow.sm,
  },
  mapsBtnIcon: { fontSize: 30 },
  mapsBtnTitle: { fontFamily: FontFamily.bold, fontSize: FontSize.base, color: Colors.accent, marginBottom: 2 },
  mapsBtnSub: { fontFamily: FontFamily.regular, fontSize: FontSize.sm, color: Colors.textMuted },
  mapsBtnArrow: { fontFamily: FontFamily.bold, fontSize: FontSize.lg, color: Colors.accent, marginLeft: 'auto' },

  // Status steps
  statusCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 16,
    ...Shadow.sm,
  },
  statusStep: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  statusStepIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  statusStepIconDone: { backgroundColor: Colors.successBg, borderColor: `${Colors.success}44` },
  statusStepIconActive: { backgroundColor: Colors.primaryBg, borderColor: `${Colors.primary}44` },
  statusStepLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.textMuted,
  },
  statusStepLabelActive: { color: Colors.text },

  cancelBtn: {
    alignSelf: 'center',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  cancelBtnText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.danger,
  },
});
