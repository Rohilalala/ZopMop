import React, { useRef, useEffect, useState, useMemo } from 'react';
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
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import { FontFamily, FontSize, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useProRoleGate } from '../../hooks/useRoleGate';
import { acceptBooking, getHelperInvites } from '../../api/matching';
import { haptics } from '../../utils/haptics';
import { showError, showInfo } from '../../utils/toast';
import OfflineBanner from '../../components/OfflineBanner';
import SvgIcon from '../../components/SvgIcon';
import { Feather } from '@expo/vector-icons';

const COUNTDOWN_SECONDS = 25;

type Props = {
  route: RouteProp<MainStackParamList, 'ProMatched'>;
};

export default function ProMatchedScreen({ route }: Props) {
  useProRoleGate();
  const { bookingId, serviceName, customerAddress, customerLat, customerLng, distanceKm } =
    route.params;
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

  const [accepting, setAccepting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const [expired, setExpired] = useState(false);

  const invitePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fillAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const cancelAlertShownRef = useRef(false);
  const expiredRef = useRef(false);

  // Countdown fill animation: 1 = full, 0 = empty
  const fillAnim = useRef(new Animated.Value(1)).current;

  // Poll the invite list every 5 s — if this booking disappears the customer cancelled.
  useEffect(() => {
    if (!token || token === '__guest__') return;
    invitePollRef.current = setInterval(async () => {
      try {
        const ids = await getHelperInvites(token);
        if (!ids.includes(bookingId) && !cancelAlertShownRef.current && !expiredRef.current) {
          cancelAlertShownRef.current = true;
          if (invitePollRef.current) clearInterval(invitePollRef.current);
          if (countdownRef.current) clearInterval(countdownRef.current);
          fillAnimRef.current?.stop();
          showInfo('The customer has cancelled this booking.', { title: 'Booking Cancelled' });
          navigation.goBack();
        }
      } catch (e) { if (__DEV__) console.warn('invite poll:', e); }
    }, 5000);
    return () => { if (invitePollRef.current) clearInterval(invitePollRef.current); };
  }, []);

  // Countdown timer
  useEffect(() => {
    // Smooth fill depletion over full duration (non-native: width % needs layout driver)
    fillAnimRef.current = Animated.timing(fillAnim, {
      toValue: 0,
      duration: COUNTDOWN_SECONDS * 1000,
      useNativeDriver: false,
    });
    fillAnimRef.current.start();

    // 1-second label ticks — pure state update, no navigation side-effects here.
    countdownRef.current = setInterval(() => {
      setSecondsLeft(prev => Math.max(0, prev - 1));
    }, 1000);

    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, []);

  // Side-effect: when the countdown hits zero, mark expired and go back.
  // Kept out of the setState updater so React Strict Mode / re-renders won't
  // double-fire the navigation call.
  useEffect(() => {
    if (secondsLeft <= 0 && !expiredRef.current) {
      expiredRef.current = true;
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
      setExpired(true);
      navigation.goBack();
    }
  }, [secondsLeft, navigation]);

  // Fire confirmation haptic the moment the invite card appears.
  useEffect(() => {
    haptics.medium();
  }, []);

  // Pulse animation for the match icon
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.08, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => { loop.stop(); };
  }, []);

  function openMaps() {
    const url = `https://maps.google.com/?q=${customerLat},${customerLng}`;
    Linking.openURL(url).catch(() => {
      showError('Please install Google Maps on your device.', { title: 'Could not open Maps' });
    });
  }

  async function handleAccept() {
    if (!token || token === '__guest__' || expired || accepting) return;
    setAccepting(true);
    haptics.heavy();
    if (countdownRef.current) clearInterval(countdownRef.current);
    fillAnimRef.current?.stop();
    try {
      await acceptBooking(token, bookingId);
      haptics.success();
      // P15: 'Service' fallback when the matching payload omits a service
      // name. Backend should always include one — see ProDashboard P13 note.
      navigation.replace('ProActive', {
        bookingId,
        serviceName: serviceName ?? 'Service',
        customerAddress,
        customerLat,
        customerLng,
      });
    } catch (err: any) {
      showError(err?.message ?? 'Please try again.', { title: 'Could not accept' });
      setAccepting(false);
    }
  }

  function handleDecline() {
    haptics.warning();
    Alert.alert('Decline booking?', 'You can decline and wait for the next one.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Decline', style: 'destructive', onPress: () => navigation.goBack() },
    ]);
  }

  const distance = distanceKm != null ? `${distanceKm.toFixed(1)} km away` : '';
  const fillWidth = fillAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <OfflineBanner />
      <ScrollView contentContainerStyle={s.content} bounces={false}>

        {/* Match Banner */}
        <View style={s.bannerWrap}>
          <View style={s.banner}>
            <View style={s.bannerCircles}>
              <View style={[s.circle, s.c1]} />
              <View style={[s.circle, s.c2]} />
            </View>
            <Animated.View style={[s.matchIcon, { transform: [{ scale: pulse }] }]}>
              <SvgIcon name="celebration" size={64} color="#FFFFFF" />
            </Animated.View>
            <Text style={s.bannerTitle}>You've been matched!</Text>
            <Text style={s.bannerSub}>A customer near you needs your help.</Text>
          </View>
        </View>

        {/* Booking Details Card */}
        <View style={s.detailCard}>
          <Text style={s.detailHeading}>Booking Details</Text>

          <DetailRow iconNode={<SvgIcon name="wrench" size={26} color={c.textMuted} />} label="Service" value={serviceName ?? 'Service'} />
          <View style={s.divider} />
          <DetailRow iconNode={<SvgIcon name="location-pin" size={26} color={c.textMuted} />} label="Location" value={customerAddress} />
          {distance ? (
            <>
              <View style={s.divider} />
              <DetailRow iconNode={<SvgIcon name="ruler-distance" size={26} color={c.textMuted} />} label="Distance" value={distance} />
            </>
          ) : null}
          <View style={s.divider} />
          <DetailRow iconNode={<Feather name="clock" size={24} color={c.textMuted} />} label="ETA" value="~30 minutes to arrive" />
        </View>

        {/* Maps Button */}
        <TouchableOpacity style={s.mapsBtn} activeOpacity={0.85} onPress={openMaps} accessibilityLabel="Open in Google Maps" accessibilityRole="button">
          <SvgIcon name="map-open" size={32} color={c.accent} />
          <View style={s.mapsBtnText}>
            <Text style={s.mapsBtnTitle}>Open in Google Maps</Text>
            <Text style={s.mapsBtnSub}>Get turn-by-turn directions</Text>
          </View>
          <Text style={s.mapsBtnArrow}>→</Text>
        </TouchableOpacity>

        {/* Info box */}
        <View style={s.infoBox}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <SvgIcon name="lightning" size={16} color={c.text} style={{ marginTop: 3 }} />
            <Text style={[s.infoText, { flex: 1 }]}>Accept quickly! This booking may be offered to other pros if you wait too long.</Text>
          </View>
        </View>
      </ScrollView>

      {/* Bottom CTAs */}
      <View style={s.bottomBar}>
        <TouchableOpacity
          style={s.declineBtn}
          activeOpacity={0.8}
          onPress={handleDecline}
          disabled={accepting || expired}
          accessibilityLabel="Decline booking"
          accessibilityRole="button"
        >
          <Text style={s.declineBtnText}>Decline</Text>
        </TouchableOpacity>

        {/* Countdown accept button */}
        <TouchableOpacity
          style={[s.acceptOuter, (accepting || expired) && { opacity: 0.6 }]}
          activeOpacity={0.88}
          onPress={handleAccept}
          disabled={accepting || expired}
          accessibilityLabel={expired ? 'Booking expired' : `Accept booking, ${secondsLeft} seconds remaining`}
          accessibilityRole="button"
        >
          {/* Animated fill — depletes right-to-left */}
          <Animated.View style={[s.acceptFill, { width: fillWidth }]} />
          {/* Label sits above fill */}
          <View style={s.acceptContent}>
            {accepting
              ? <LoadingBars color="#FFFFFF" />
              : expired
                ? <Text style={s.acceptBtnText}>Expired</Text>
                : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <SvgIcon name="check-circle" size={18} color="#FFFFFF" />
                  <Text style={s.acceptBtnText}>Accept ({secondsLeft}s)</Text>
                </View>
              )
            }
          </View>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function DetailRow({ iconNode, label, value }: { iconNode: React.ReactNode; label: string; value: string }) {
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.detailRow}>
      <View style={s.detailIconWrap}>{iconNode}</View>
      <View style={s.detailTexts}>
        <Text style={s.detailLabel}>{label}</Text>
        <Text style={s.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

function createStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    content: { paddingBottom: 24 },

    bannerWrap: { paddingHorizontal: 20, paddingTop: 20, marginBottom: 20 },
    banner: {
      backgroundColor: c.primary,
      borderRadius: Radius['2xl'],
      padding: 32,
      alignItems: 'center',
      overflow: 'hidden',
    },
    bannerCircles: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    circle: { position: 'absolute', borderRadius: Radius.full, backgroundColor: '#FFFFFF' },
    c1: { width: 160, height: 160, opacity: 0.06, top: -60, right: -40 },
    c2: { width: 80, height: 80, opacity: 0.05, bottom: -20, left: 30 },

    matchIcon: { marginBottom: 14 },
    bannerTitle: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize['2xl'],
      color: '#FFFFFF',
      letterSpacing: -0.5,
      marginBottom: 6,
    },
    bannerSub: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: 'rgba(255,255,255,0.78)',
      textAlign: 'center',
    },

    detailCard: {
      marginHorizontal: 20,
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: c.border,
      padding: 20,
      marginBottom: 16,
      ...Shadow.sm,
    },
    detailHeading: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.lg,
      color: c.text,
      marginBottom: 18,
      letterSpacing: -0.2,
    },
    detailRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 14,
      paddingVertical: 4,
    },
    detailIconWrap: { width: 32, alignItems: 'center', marginTop: 2 },
    detailTexts: { flex: 1 },
    detailLabel: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.textMuted,
      marginBottom: 2,
    },
    detailValue: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.text,
      lineHeight: 22,
    },
    divider: { height: 1, backgroundColor: c.border, marginVertical: 12, marginLeft: 46 },

    mapsBtn: {
      marginHorizontal: 20,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      borderWidth: 1.5,
      borderColor: c.accent,
      padding: 18,
      gap: 14,
      marginBottom: 16,
      ...Shadow.sm,
    },
    mapsBtnText: { flex: 1 },
    mapsBtnTitle: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: c.accent,
      marginBottom: 2,
    },
    mapsBtnSub: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textMuted,
    },
    mapsBtnArrow: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.lg,
      color: c.accent,
    },

    infoBox: {
      marginHorizontal: 20,
      backgroundColor: c.warningBg,
      borderRadius: Radius.xl,
      padding: 16,
      borderWidth: 1,
      borderColor: `${c.warning}44`,
    },
    infoText: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.text,
      lineHeight: 22,
    },

    bottomBar: {
      flexDirection: 'row',
      paddingHorizontal: 20,
      paddingVertical: 16,
      gap: 12,
      backgroundColor: c.background,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    declineBtn: {
      flex: 1,
      paddingVertical: 18,
      borderRadius: Radius.xl,
      borderWidth: 1.5,
      borderColor: c.border,
      alignItems: 'center',
      backgroundColor: c.white,
    },
    declineBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.base,
      color: c.textSecondary,
    },

    // Countdown accept button
    acceptOuter: {
      flex: 2,
      height: 58,
      borderRadius: Radius.xl,
      overflow: 'hidden',
      backgroundColor: `${c.success}30`,
      ...Shadow.md,
    },
    acceptFill: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      backgroundColor: c.success,
    },
    acceptContent: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    acceptBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.base,
      color: '#FFFFFF',
      letterSpacing: 0.2,
    },
  });
}
