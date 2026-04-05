import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Animated,
  Alert,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';

const { width: W } = Dimensions.get('window');

const SERVICES = [
  { id: 'cleaning', emoji: '🏠', label: 'Home Cleaning' },
  { id: 'kitchen', emoji: '🍳', label: 'Kitchen Work' },
  { id: 'laundry', emoji: '👕', label: 'Laundry & Ironing' },
  { id: 'petcare', emoji: '🐾', label: 'Pet Care' },
  { id: 'gardening', emoji: '🌿', label: 'Gardening' },
  { id: 'carclean', emoji: '🚗', label: 'Car Cleaning' },
];

const AVAILABILITY_SLOTS = [
  { id: 'morning', label: 'Morning', time: '6am – 12pm' },
  { id: 'afternoon', label: 'Afternoon', time: '12pm – 5pm' },
  { id: 'evening', label: 'Evening', time: '5pm – 10pm' },
];

const TOTAL_STEPS = 4;

type Props = {
  route: RouteProp<AuthStackParamList, 'ProOnboarding'>;
};

export default function ProOnboardingScreen({ route }: Props) {
  const { phone, backendToken, backendUser } = route.params;
  const navigation = useNavigation<NativeStackNavigationProp<AuthStackParamList>>();
  const { signIn } = useAuth();

  const [step, setStep] = useState(1);
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [address, setAddress] = useState('');
  const [gpsLat, setGpsLat] = useState<number | null>(null);
  const [gpsLng, setGpsLng] = useState<number | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Step dot animation
  const dotAnims = useRef(
    Array.from({ length: TOTAL_STEPS }, (_, i) =>
      new Animated.Value(i === 0 ? 1 : 0)
    )
  ).current;

  useEffect(() => {
    dotAnims.forEach((anim, i) => {
      Animated.timing(anim, {
        toValue: i < step ? 1 : 0,
        duration: 250,
        useNativeDriver: false,
      }).start();
    });
  }, [step]);

  // ── GPS ────────────────────────────────────────────────────────────────────
  async function handleDetectLocation() {
    setGpsLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Location needed',
          'Please allow location access so we can match you with nearby customers.'
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setGpsLat(pos.coords.latitude);
      setGpsLng(pos.coords.longitude);

      const [place] = await Location.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      if (place) {
        const parts = [place.name, place.district, place.city].filter(Boolean);
        setAddress(parts.join(', '));
      }
    } catch {
      Alert.alert('Could not detect location', 'Please try again or contact support.');
    } finally {
      setGpsLoading(false);
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleGoLive() {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (!backendToken) {
        Alert.alert('Connection Error', 'Cannot reach the server. Check your network and try again.');
        return;
      }
      if (!gpsLat || !gpsLng) {
        Alert.alert('Location required', 'Please detect your location first.');
        return;
      }
      const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';
      const res = await fetch(`${BASE_URL}/me/onboard-pro`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${backendToken}`,
        },
        body: JSON.stringify({
          lat: gpsLat,
          lng: gpsLng,
          services: selectedServices,
          availability: selectedSlots,
          address,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Onboarding failed (HTTP ${res.status}): ${text}`);
      }

      const data = await res.json();

      // Push GPS to Redis so matching engine can find this pro immediately.
      await fetch(`${BASE_URL}/helpers/me/location`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.token}`,
        },
        body: JSON.stringify({ lat: gpsLat, lng: gpsLng }),
      });

      signIn(data.token, data.user);
    } catch (err: any) {
      Alert.alert('Something went wrong', err.message ?? 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step navigation ────────────────────────────────────────────────────────
  function nextStep() {
    if (step === 1) {
      if (selectedServices.length === 0) {
        Alert.alert('Pick a service', 'Select at least one service you can do.');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      if (!gpsLat || !gpsLng) {
        Alert.alert('Location needed', 'Tap "Use my location" to capture your GPS.');
        return;
      }
      setStep(3);
    } else if (step === 3) {
      if (selectedSlots.length === 0) {
        Alert.alert('Pick availability', 'Select at least one time slot.');
        return;
      }
      setStep(4);
    }
  }

  function toggleService(id: string) {
    setSelectedServices(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  }

  function toggleSlot(id: string) {
    setSelectedSlots(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* ── Header ── */}
        <View style={s.header}>
          {step > 1 && step < 4 && (
            <TouchableOpacity
              style={s.backBtn}
              onPress={() => setStep(step - 1)}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={s.backArrow}>‹</Text>
            </TouchableOpacity>
          )}
          <View style={s.dotsRow}>
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <Animated.View
                key={i}
                style={[
                  s.dot,
                  {
                    backgroundColor: dotAnims[i].interpolate({
                      inputRange: [0, 1],
                      outputRange: [Colors.border, Colors.primary],
                    }),
                    width: dotAnims[i].interpolate({
                      inputRange: [0, 1],
                      outputRange: [8, 24],
                    }),
                  },
                ]}
              />
            ))}
          </View>
        </View>

        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >

          {/* ── Step 1: Services ───────────────────────────────────────────── */}
          {step === 1 && (
            <View style={s.stepContainer}>
              <Text style={s.stepTitle}>What can you do?</Text>
              <Text style={s.stepSub}>Pick all services you are comfortable with.</Text>

              <View style={s.serviceGrid}>
                {SERVICES.map(svc => {
                  const selected = selectedServices.includes(svc.id);
                  return (
                    <TouchableOpacity
                      key={svc.id}
                      style={[s.serviceCard, selected && s.serviceCardSelected]}
                      activeOpacity={0.85}
                      onPress={() => toggleService(svc.id)}
                    >
                      {selected && <View style={s.checkBadge}><Text style={s.checkMark}>✓</Text></View>}
                      <Text style={s.serviceEmoji}>{svc.emoji}</Text>
                      <Text style={[s.serviceLabel, selected && s.serviceLabelSelected]}>
                        {svc.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {selectedServices.length > 0 && (
                <Text style={s.selectionHint}>
                  {selectedServices.length} service{selectedServices.length !== 1 ? 's' : ''} selected
                </Text>
              )}
            </View>
          )}

          {/* ── Step 2: Location ───────────────────────────────────────────── */}
          {step === 2 && (
            <View style={s.stepContainer}>
              <Text style={s.stepTitle}>Where do you work?</Text>
              <Text style={s.stepSub}>
                We use your location to match you with nearby customers.
              </Text>

              <TouchableOpacity
                style={[s.locationBtn, gpsLoading && s.locationBtnLoading, gpsLat != null && s.locationBtnDone]}
                activeOpacity={0.85}
                onPress={handleDetectLocation}
                disabled={gpsLoading}
              >
                {gpsLoading ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : gpsLat != null ? (
                  <Text style={s.locationBtnText}>✓  Location captured</Text>
                ) : (
                  <Text style={s.locationBtnText}>📍  Use my location</Text>
                )}
              </TouchableOpacity>

              {address ? (
                <View style={s.addressBadge}>
                  <Text style={s.addressBadgeText}>{address}</Text>
                </View>
              ) : null}

              <Text style={s.locationNote}>
                Your exact location is only used for matching — customers only see your area name.
              </Text>
            </View>
          )}

          {/* ── Step 3: Availability ───────────────────────────────────────── */}
          {step === 3 && (
            <View style={s.stepContainer}>
              <Text style={s.stepTitle}>When can you work?</Text>
              <Text style={s.stepSub}>Select all time slots that work for you.</Text>

              <View style={s.slotsRow}>
                {AVAILABILITY_SLOTS.map(slot => {
                  const active = selectedSlots.includes(slot.id);
                  return (
                    <TouchableOpacity
                      key={slot.id}
                      style={[s.slotPill, active && s.slotPillActive]}
                      activeOpacity={0.85}
                      onPress={() => toggleSlot(slot.id)}
                    >
                      <Text style={[s.slotLabel, active && s.slotLabelActive]}>{slot.label}</Text>
                      <Text style={[s.slotTime, active && s.slotTimeActive]}>{slot.time}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* ── Step 4: Completion ─────────────────────────────────────────── */}
          {step === 4 && (
            <View style={[s.stepContainer, s.completionContainer]}>
              <View style={s.successIcon}>
                <Text style={s.successEmoji}>🎉</Text>
              </View>
              <Text style={s.completionTitle}>You're all set!</Text>
              <Text style={s.completionSub}>You are ready to start working</Text>

              <View style={s.summaryCard}>
                <SummaryRow
                  label="Services"
                  value={selectedServices
                    .map(id => SERVICES.find(s => s.id === id)?.label ?? id)
                    .join(', ')}
                />
                <SummaryRow
                  label="Available"
                  value={selectedSlots
                    .map(id => AVAILABILITY_SLOTS.find(s => s.id === id)?.label ?? id)
                    .join(', ')}
                />
                {address ? <SummaryRow label="Area" value={address} /> : null}
              </View>
            </View>
          )}

        </ScrollView>

        {/* ── CTA ── */}
        <View style={s.ctaWrap}>
          {step < 4 ? (
            <TouchableOpacity
              style={[
                s.ctaBtn,
                step === 1 && selectedServices.length === 0 && s.ctaBtnDisabled,
                step === 2 && !gpsLat && s.ctaBtnDisabled,
                step === 3 && selectedSlots.length === 0 && s.ctaBtnDisabled,
              ]}
              activeOpacity={0.88}
              onPress={nextStep}
            >
              <Text style={s.ctaBtnText}>Continue</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[s.ctaBtn, s.ctaBtnGo, submitting && s.ctaBtnDisabled]}
              activeOpacity={0.88}
              onPress={handleGoLive}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <Text style={s.ctaBtnText}>Start Working</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.summaryRow}>
      <Text style={s.summaryLabel}>{label}</Text>
      <Text style={s.summaryValue}>{value}</Text>
    </View>
  );
}

const CARD_SIZE = (W - Spacing['2xl'] * 2 - Spacing.md) / 2;

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: Spacing.xl },

  // ── Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing['2xl'],
    paddingTop: Spacing.md,
    paddingBottom: Spacing.base,
    gap: Spacing.md,
    minHeight: 56,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  backArrow: {
    fontSize: 28,
    color: Colors.text,
    lineHeight: 32,
    marginTop: -2,
  },
  dotsRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  dot: {
    height: 8,
    borderRadius: Radius.full,
  },

  // ── Step content
  stepContainer: {
    paddingHorizontal: Spacing['2xl'],
    paddingTop: Spacing.lg,
  },
  stepTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize['3xl'],
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: Spacing.sm,
  },
  stepSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    lineHeight: FontSize.base * 1.6,
    marginBottom: Spacing['2xl'],
  },

  // ── Service grid
  serviceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.md,
  },
  serviceCard: {
    width: CARD_SIZE,
    aspectRatio: 1,
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    ...Shadow.sm,
  },
  serviceCardSelected: {
    borderColor: Colors.primary,
    borderWidth: 2,
    backgroundColor: Colors.primaryBg,
    ...Shadow.md,
  },
  checkBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.sm,
    color: Colors.white,
  },
  serviceEmoji: { fontSize: 40 },
  serviceLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.text,
    textAlign: 'center',
    paddingHorizontal: Spacing.xs,
  },
  serviceLabelSelected: { color: Colors.primary },
  selectionHint: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing.base,
  },

  // ── Location
  locationBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    paddingVertical: 20,
    alignItems: 'center',
    marginBottom: Spacing.base,
    ...Shadow.md,
  },
  locationBtnLoading: { opacity: 0.75 },
  locationBtnDone: { backgroundColor: Colors.success },
  locationBtnText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.white,
  },
  addressBadge: {
    backgroundColor: Colors.successBg,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.base,
    alignItems: 'center',
  },
  addressBadgeText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.success,
    textAlign: 'center',
  },
  locationNote: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: FontSize.sm * 1.7,
    marginTop: Spacing.sm,
  },

  // ── Availability pills
  slotsRow: {
    gap: Spacing.md,
  },
  slotPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    paddingVertical: Spacing.base,
    paddingHorizontal: Spacing.lg,
    ...Shadow.sm,
  },
  slotPillActive: {
    borderColor: Colors.primary,
    borderWidth: 2,
    backgroundColor: Colors.primaryBg,
  },
  slotLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  slotLabelActive: { color: Colors.primary },
  slotTime: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  slotTimeActive: { color: Colors.primary },

  // ── Completion
  completionContainer: {
    alignItems: 'center',
    paddingTop: Spacing['4xl'],
  },
  successIcon: {
    width: 100,
    height: 100,
    borderRadius: Radius.full,
    backgroundColor: Colors.successBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
    ...Shadow.md,
  },
  successEmoji: { fontSize: 52 },
  completionTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize['3xl'],
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: Spacing.sm,
    textAlign: 'center',
  },
  completionSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing['2xl'],
  },
  summaryCard: {
    width: '100%',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.md,
    ...Shadow.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: Spacing.md,
  },
  summaryLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    width: 70,
  },
  summaryValue: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.text,
    flex: 1,
  },

  // ── CTA
  ctaWrap: {
    paddingHorizontal: Spacing['2xl'],
    paddingBottom: Spacing.xl,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  ctaBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    paddingVertical: 18,
    alignItems: 'center',
    ...Shadow.md,
  },
  ctaBtnDisabled: { opacity: 0.45 },
  ctaBtnGo: { backgroundColor: Colors.success },
  ctaBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.white,
    letterSpacing: 0.2,
  },
});
