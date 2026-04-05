import React, { useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Linking,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { MainStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { acceptBooking } from '../../api/matching';

const { width: W } = Dimensions.get('window');

type Props = {
  route: RouteProp<MainStackParamList, 'ProMatched'>;
};

export default function ProMatchedScreen({ route }: Props) {
  const { bookingId, serviceName, customerAddress, customerLat, customerLng, distanceKm } =
    route.params;
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const { token } = useAuth();

  const [accepting, setAccepting] = useState(false);

  // Pulse animation for the match icon
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.08, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    ).start();
  }, []);

  function openMaps() {
    const url = `https://maps.google.com/?q=${customerLat},${customerLng}`;
    Linking.openURL(url).catch(() => {
      Alert.alert('Could not open Maps', 'Please install Google Maps on your device.');
    });
  }

  async function handleAccept() {
    if (!token || token === '__guest__') return;
    setAccepting(true);
    try {
      await acceptBooking(token, bookingId);
      navigation.replace('ActiveBooking', {
        bookingId,
        serviceName: serviceName ?? 'Home Service',
        helperName: customerAddress,
        helperRating: 0,
        helperLat: customerLat,
        helperLng: customerLng,
        etaMinutes: 30,
      });
    } catch (err: any) {
      Alert.alert('Could not accept', err?.message ?? 'Please try again.');
      setAccepting(false);
    }
  }

  function handleDecline() {
    Alert.alert('Decline booking?', 'You can decline and wait for the next one.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Decline', style: 'destructive', onPress: () => navigation.goBack() },
    ]);
  }

  const distance = distanceKm != null ? `${distanceKm.toFixed(1)} km away` : '';

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={s.content} bounces={false}>

        {/* Match Banner */}
        <View style={s.bannerWrap}>
          <View style={s.banner}>
            <View style={s.bannerCircles}>
              <View style={[s.circle, s.c1]} />
              <View style={[s.circle, s.c2]} />
            </View>
            <Animated.Text style={[s.matchIcon, { transform: [{ scale: pulse }] }]}>
              🎉
            </Animated.Text>
            <Text style={s.bannerTitle}>You've been matched!</Text>
            <Text style={s.bannerSub}>A customer near you needs your help.</Text>
          </View>
        </View>

        {/* Booking Details Card */}
        <View style={s.detailCard}>
          <Text style={s.detailHeading}>Booking Details</Text>

          <DetailRow icon="🛠️" label="Service" value={serviceName ?? 'Home Service'} />
          <View style={s.divider} />
          <DetailRow icon="📍" label="Location" value={customerAddress} />
          {distance ? (
            <>
              <View style={s.divider} />
              <DetailRow icon="📏" label="Distance" value={distance} />
            </>
          ) : null}
          <View style={s.divider} />
          <DetailRow icon="⏱️" label="ETA" value="~30 minutes to arrive" />
        </View>

        {/* Maps Button */}
        <TouchableOpacity style={s.mapsBtn} activeOpacity={0.85} onPress={openMaps}>
          <Text style={s.mapsBtnIcon}>🗺️</Text>
          <View style={s.mapsBtnText}>
            <Text style={s.mapsBtnTitle}>Open in Google Maps</Text>
            <Text style={s.mapsBtnSub}>Get turn-by-turn directions</Text>
          </View>
          <Text style={s.mapsBtnArrow}>→</Text>
        </TouchableOpacity>

        {/* Info box */}
        <View style={s.infoBox}>
          <Text style={s.infoText}>
            ⚡  Accept quickly! This booking may be offered to other pros if you wait too long.
          </Text>
        </View>
      </ScrollView>

      {/* Bottom CTAs */}
      <View style={s.bottomBar}>
        <TouchableOpacity
          style={s.declineBtn}
          activeOpacity={0.8}
          onPress={handleDecline}
          disabled={accepting}
        >
          <Text style={s.declineBtnText}>Decline</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.acceptBtn, accepting && { opacity: 0.7 }]}
          activeOpacity={0.88}
          onPress={handleAccept}
          disabled={accepting}
        >
          {accepting
            ? <ActivityIndicator color={Colors.white} />
            : <Text style={s.acceptBtnText}>✅  I'm on my way</Text>
          }
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={s.detailRow}>
      <Text style={s.detailIcon}>{icon}</Text>
      <View style={s.detailTexts}>
        <Text style={s.detailLabel}>{label}</Text>
        <Text style={s.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  content: { paddingBottom: 24 },

  bannerWrap: { paddingHorizontal: 20, paddingTop: 20, marginBottom: 20 },
  banner: {
    backgroundColor: Colors.primary,
    borderRadius: Radius['2xl'],
    padding: 32,
    alignItems: 'center',
    overflow: 'hidden',
  },
  bannerCircles: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  circle: { position: 'absolute', borderRadius: Radius.full, backgroundColor: Colors.white },
  c1: { width: 160, height: 160, opacity: 0.06, top: -60, right: -40 },
  c2: { width: 80, height: 80, opacity: 0.05, bottom: -20, left: 30 },

  matchIcon: { fontSize: 64, marginBottom: 14 },
  bannerTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize['2xl'],
    color: Colors.white,
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
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    marginBottom: 16,
    ...Shadow.sm,
  },
  detailHeading: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.text,
    marginBottom: 18,
    letterSpacing: -0.2,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: 4,
  },
  detailIcon: { fontSize: 26, width: 32, textAlign: 'center', marginTop: 2 },
  detailTexts: { flex: 1 },
  detailLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  detailValue: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.text,
    lineHeight: 22,
  },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: 12, marginLeft: 46 },

  mapsBtn: {
    marginHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.accent,
    padding: 18,
    gap: 14,
    marginBottom: 16,
    ...Shadow.sm,
  },
  mapsBtnIcon: { fontSize: 32 },
  mapsBtnText: { flex: 1 },
  mapsBtnTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.accent,
    marginBottom: 2,
  },
  mapsBtnSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  mapsBtnArrow: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.accent,
  },

  infoBox: {
    marginHorizontal: 20,
    backgroundColor: Colors.warningBg,
    borderRadius: Radius.xl,
    padding: 16,
    borderWidth: 1,
    borderColor: `${Colors.warning}44`,
  },
  infoText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.text,
    lineHeight: 22,
  },

  bottomBar: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 12,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  declineBtn: {
    flex: 1,
    paddingVertical: 18,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    backgroundColor: Colors.white,
  },
  declineBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
  },
  acceptBtn: {
    flex: 2,
    paddingVertical: 18,
    borderRadius: Radius.xl,
    backgroundColor: Colors.success,
    alignItems: 'center',
    ...Shadow.md,
  },
  acceptBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.white,
    letterSpacing: 0.2,
  },
});
