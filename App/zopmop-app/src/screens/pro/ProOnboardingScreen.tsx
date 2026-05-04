import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  
  Animated,
  Alert,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { lightColors } from '../../theme/colors';
import { FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useColors } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { BASE_URL } from '../../api/config';
import { pendingAuthStore } from '../../utils/pendingAuthStore';
import { apiFetch } from '../../api/client';
import { showError } from '../../utils/toast';

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
  const { phone } = route.params;
  const navigation = useNavigation<NativeStackNavigationProp<AuthStackParamList>>();
  const { signIn } = useAuth();
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);

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
        showError('Please allow location access so we can match you with nearby customers.', { title: 'Location needed' });
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
      showError('Please try again or contact support.', { title: 'Could not detect location' });
    } finally {
      setGpsLoading(false);
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleGoLive() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const pending = pendingAuthStore.get();
      if (!pending?.token) {
        showError('Cannot reach the server. Check your network and try again.', { title: 'Connection Error' });
        return;
      }
      if (!gpsLat || !gpsLng) {
        showError('Please detect your location first.', { title: 'Location required' });
        return;
      }

      const res = await apiFetch(`${BASE_URL}/me/onboard-pro`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pending.token}`,
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
        throw new Error('Onboarding failed. Please check your details and try again.');
      }

      const data = await res.json();

      // Push GPS to Redis so matching engine can find this pro immediately.
      await apiFetch(`${BASE_URL}/helpers/me/location`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.token}`,
        },
        body: JSON.stringify({ lat: gpsLat, lng: gpsLng }),
      });

      signIn(data.token, data.user);
      pendingAuthStore.clear();
    } catch (err: any) {
      showError('Please check your details and try again.', { title: 'Something went wrong' });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step navigation ────────────────────────────────────────────────────────
  function nextStep() {
    if (step === 1) {
      if (selectedServices.length === 0) {
        showError('Select at least one service you can do.', { title: 'Pick a service' });
        return;
      }
      setStep(2);
    } else if (step === 2) {
      if (!gpsLat || !gpsLng) {
        showError('Tap "Use my location" to capture your GPS.', { title: 'Location needed' });
        return;
      }
      setStep(3);
    } else if (step === 3) {
      if (selectedSlots.length === 0) {
        showError('Select at least one time slot.', { title: 'Pick availability' });
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
                      outputRange: [c.border, c.primary],
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
                  <LoadingBars size="small" color="#FFFFFF" />
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
                <LoadingBars color="#FFFFFF" />
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
  const c = useColors();
  const s = useMemo(() => createStyles(c), [c]);
  return (
    <View style={s.summaryRow}>
      <Text style={s.summaryLabel}>{label}</Text>
      <Text style={s.summaryValue}>{value}</Text>
    </View>
  );
}

const CARD_SIZE = (W - Spacing['2xl'] * 2 - Spacing.md) / 2;

function createStyles(c: typeof lightColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
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
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
    },
    backArrow: {
      fontSize: 28,
      color: c.text,
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
      color: c.text,
      letterSpacing: -0.5,
      marginBottom: Spacing.sm,
    },
    stepSub: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.textSecondary,
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
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      borderWidth: 1.5,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.sm,
      ...Shadow.sm,
    },
    serviceCardSelected: {
      borderColor: c.primary,
      borderWidth: 2,
      backgroundColor: c.primaryBg,
      ...Shadow.md,
    },
    checkBadge: {
      position: 'absolute',
      top: 10,
      right: 10,
      width: 22,
      height: 22,
      borderRadius: Radius.full,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkMark: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.sm,
      color: '#FFFFFF',
    },
    serviceEmoji: { fontSize: 40 },
    serviceLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.sm,
      color: c.text,
      textAlign: 'center',
      paddingHorizontal: Spacing.xs,
    },
    serviceLabelSelected: { color: c.primary },
    selectionHint: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.textSecondary,
      textAlign: 'center',
      marginTop: Spacing.base,
    },

    // ── Location
    locationBtn: {
      backgroundColor: c.primary,
      borderRadius: Radius.xl,
      paddingVertical: 20,
      alignItems: 'center',
      marginBottom: Spacing.base,
      ...Shadow.md,
    },
    locationBtnLoading: { opacity: 0.75 },
    locationBtnDone: { backgroundColor: c.success },
    locationBtnText: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.md,
      color: '#FFFFFF',
    },
    addressBadge: {
      backgroundColor: c.successBg,
      borderRadius: Radius.lg,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.sm,
      marginBottom: Spacing.base,
      alignItems: 'center',
    },
    addressBadgeText: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.success,
      textAlign: 'center',
    },
    locationNote: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textMuted,
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
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      borderWidth: 1.5,
      borderColor: c.border,
      paddingVertical: Spacing.base,
      paddingHorizontal: Spacing.lg,
      ...Shadow.sm,
    },
    slotPillActive: {
      borderColor: c.primary,
      borderWidth: 2,
      backgroundColor: c.primaryBg,
    },
    slotLabel: {
      fontFamily: FontFamily.semibold,
      fontSize: FontSize.md,
      color: c.text,
    },
    slotLabelActive: { color: c.primary },
    slotTime: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.sm,
      color: c.textMuted,
    },
    slotTimeActive: { color: c.primary },

    // ── Completion
    completionContainer: {
      alignItems: 'center',
      paddingTop: Spacing['4xl'],
    },
    successIcon: {
      width: 100,
      height: 100,
      borderRadius: Radius.full,
      backgroundColor: c.successBg,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Spacing.xl,
      ...Shadow.md,
    },
    successEmoji: { fontSize: 52 },
    completionTitle: {
      fontFamily: FontFamily.extrabold,
      fontSize: FontSize['3xl'],
      color: c.text,
      letterSpacing: -0.5,
      marginBottom: Spacing.sm,
      textAlign: 'center',
    },
    completionSub: {
      fontFamily: FontFamily.regular,
      fontSize: FontSize.base,
      color: c.textSecondary,
      textAlign: 'center',
      marginBottom: Spacing['2xl'],
    },
    summaryCard: {
      width: '100%',
      backgroundColor: c.white,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: c.border,
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
      color: c.textSecondary,
      width: 70,
    },
    summaryValue: {
      fontFamily: FontFamily.medium,
      fontSize: FontSize.sm,
      color: c.text,
      flex: 1,
    },

    // ── CTA
    ctaWrap: {
      paddingHorizontal: Spacing['2xl'],
      paddingBottom: Spacing.xl,
      paddingTop: Spacing.md,
      backgroundColor: c.background,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    ctaBtn: {
      backgroundColor: c.primary,
      borderRadius: Radius.xl,
      paddingVertical: 18,
      alignItems: 'center',
      ...Shadow.md,
    },
    ctaBtnDisabled: { opacity: 0.45 },
    ctaBtnGo: { backgroundColor: c.success },
    ctaBtnText: {
      fontFamily: FontFamily.bold,
      fontSize: FontSize.lg,
      color: '#FFFFFF',
      letterSpacing: 0.2,
    },
  });
}
