// ProScheduledInviteScreen — distinct from ProMatchedScreen.
//
// Surfaces a pre-scheduled job invite to the pro: date, time slot, services,
// customer area (NOT full address until accept), notes, total duration.
// 25s amber countdown. Accept → POST /bookings/:id/accept → ProDashboard.
// Decline / timeout → goBack to ProDashboard.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';

import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { acceptBooking } from '../../api/matching';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { haptics } from '../../utils/haptics';
import { showError } from '../../utils/toast';

const COUNTDOWN_SECONDS = 25;

type Props = { route: RouteProp<MainStackParamList, 'ProScheduledInvite'> };

export default function ProScheduledInviteScreen({ route }: Props) {
  const {
    bookingId,
    scheduledTime,
    durationMinutes,
    customerArea,
    services,
    notes,
  } = route.params;

  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const [accepting, setAccepting] = useState(false);
  const [expired, setExpired] = useState(false);
  const expiredRef = useRef(false);
  const fillAnim = useRef(new Animated.Value(1)).current;

  // Confirmation haptic on entry.
  useEffect(() => {
    haptics.medium();
  }, []);

  // Smooth fill depletion + 1s tick.
  useEffect(() => {
    Animated.timing(fillAnim, {
      toValue: 0,
      duration: COUNTDOWN_SECONDS * 1000,
      useNativeDriver: false,
    }).start();
    const tick = setInterval(() => setSecondsLeft((p) => Math.max(0, p - 1)), 1000);
    return () => clearInterval(tick);
  }, []);

  // Expiry side-effect.
  useEffect(() => {
    if (secondsLeft <= 0 && !expiredRef.current) {
      expiredRef.current = true;
      setExpired(true);
      // Brief visual hold on "Expired" before bouncing back.
      const t = setTimeout(() => navigation.goBack(), 600);
      return () => clearTimeout(t);
    }
  }, [secondsLeft, navigation]);

  async function handleAccept() {
    if (!token || token === '__guest__' || expired || accepting) return;
    haptics.heavy();
    fillAnim.stopAnimation();
    setAccepting(true);
    try {
      await acceptBooking(token, bookingId);
      haptics.success();
      navigation.replace('ProDashboard');
    } catch (err: any) {
      showError(err?.message ?? 'Please try again.', { title: 'Could not accept' });
      setAccepting(false);
    }
  }

  function handleDecline() {
    haptics.warning();
    navigation.goBack();
  }

  // Date / time formatting — "Tomorrow, 15 Jan" + "10:00 AM — 12:00 PM".
  const sched = new Date(scheduledTime);
  const end = new Date(sched.getTime() + durationMinutes * 60_000);
  const dateLabel = formatRelativeDate(sched);
  const timeLabel = `${fmtTime(sched)} — ${fmtTime(end)}`;
  const fillWidth = fillAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={s.content} bounces={false}>
        <View style={s.tag}>
          <Text style={s.tagText}>SCHEDULED JOB</Text>
        </View>

        <Text style={s.dateBig}>{dateLabel}</Text>
        <Text style={s.timeBig}>{timeLabel}</Text>

        <View style={s.card}>
          <Row label="Area" value={customerArea} />
          <Divider />
          <Row label="Total time" value={`~${formatDuration(durationMinutes)}`} />
          {services && services.length > 0 ? (
            <>
              <Divider />
              <View style={s.row}>
                <Text style={s.rowLabel}>Services</Text>
                <View style={{ flex: 1 }}>
                  {services.map((sv, i) => (
                    <Text key={`${sv.name}-${i}`} style={s.rowValue}>
                      {sv.name} · {formatDuration(sv.durationMinutes)}
                    </Text>
                  ))}
                </View>
              </View>
            </>
          ) : null}
          {notes ? (
            <>
              <Divider />
              <View style={s.row}>
                <Text style={s.rowLabel}>Notes</Text>
                <Text style={[s.rowValue, { flex: 1 }]}>{notes}</Text>
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>

      {/* Sticky CTAs */}
      <View style={s.ctas}>
        <TouchableOpacity style={s.declineBtn} activeOpacity={0.8} onPress={handleDecline} disabled={accepting}>
          <Text style={s.declineBtnText}>Decline</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.acceptBtn, expired && s.acceptBtnExpired]}
          activeOpacity={0.85}
          onPress={handleAccept}
          disabled={accepting || expired}
        >
          <Animated.View style={[s.acceptFill, { width: fillWidth }]} />
          <View style={s.acceptContent}>
            {accepting ? (
              <LoadingBars color="#FFFFFF" />
            ) : expired ? (
              <Text style={s.acceptText}>Expired</Text>
            ) : (
              <Text style={s.acceptText}>Accept · {secondsLeft}s</Text>
            )}
          </View>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ── small bits ─────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, { flex: 1 }]}>{value}</Text>
    </View>
  );
}

function Divider() {
  const c = useColors();
  return <View style={{ height: 1, backgroundColor: c.border, opacity: 0.5 }} />;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatRelativeDate(d: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  const dayMonth = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (days === 0) return `Today, ${dayMonth}`;
  if (days === 1) return `Tomorrow, ${dayMonth}`;
  return `${d.toLocaleDateString([], { weekday: 'long' })}, ${dayMonth}`;
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24 },

    tag: {
      alignSelf: 'flex-start',
      backgroundColor: c.primary,
      borderRadius: Radius.full,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginBottom: 16,
    },
    tagText: {
      fontFamily: FontFamily.bold,
      fontSize: 11,
      color: '#0D0D0F',
      letterSpacing: 1.2,
    },

    dateBig: {
      fontFamily: FontFamily.extrabold,
      fontSize: 32,
      color: c.text,
      letterSpacing: -0.6,
      marginBottom: 4,
    },
    timeBig: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize['xl'],
      color: c.primary,
      marginBottom: 24,
    },

    card: {
      backgroundColor: c.surface,
      borderRadius: Radius['2xl'],
      padding: 18,
      ...Shadow.md,
    },
    row: {
      flexDirection: 'row',
      paddingVertical: 12,
      gap: 16,
    },
    rowLabel: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.textMuted,
      width: 96,
    },
    rowValue: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.text,
    },

    ctas: {
      flexDirection: 'row',
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 8,
      backgroundColor: c.background,
    },
    declineBtn: {
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: 'transparent',
      justifyContent: 'center',
      alignItems: 'center',
    },
    declineBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: c.text,
    },
    acceptBtn: {
      flex: 1,
      borderRadius: Radius.full,
      backgroundColor: c.primary,
      overflow: 'hidden',
      ...Shadow.md,
    },
    acceptBtnExpired: { backgroundColor: c.border },
    acceptFill: {
      position: 'absolute',
      top: 0, bottom: 0, left: 0,
      backgroundColor: 'rgba(255,255,255,0.18)',
    },
    acceptContent: {
      paddingVertical: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    acceptText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: '#0D0D0F',
    },
  });
}
