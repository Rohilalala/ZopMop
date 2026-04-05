import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Animated,
  Alert,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { AuthStackParamList } from '../../types/navigation';
import { Colors, FontFamily, FontSize, Spacing, Radius, Shadow } from '../../theme';
import { useAuth } from '../../context/AuthContext';

const { width: W } = Dimensions.get('window');

// All services a pro can offer
const ALL_SERVICES = [
  { id: 'sweep', emoji: '🧹', label: 'Sweeping & Mopping' },
  { id: 'bathroom', emoji: '🚿', label: 'Bathroom Cleaning' },
  { id: 'utensils', emoji: '🍽️', label: 'Utensils / Dishes' },
  { id: 'dusting', emoji: '🧽', label: 'Dusting & Wiping' },
  { id: 'kitchen', emoji: '🔪', label: 'Kitchen Prep' },
  { id: 'laundry', emoji: '👕', label: 'Laundry & Folding' },
  { id: 'ironing', emoji: '🏠', label: 'Ironing' },
  { id: 'gardening', emoji: '🌿', label: 'Gardening' },
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
  const [bio, setBio] = useState('');
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [locationText, setLocationText] = useState('');
  const [gpsLat, setGpsLat] = useState<number | null>(null);
  const [gpsLng, setGpsLng] = useState<number | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Progress bar animation
  const progressAnim = useRef(new Animated.Value(1 / TOTAL_STEPS)).current;

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: step / TOTAL_STEPS,
      duration: 350,
      useNativeDriver: false,
    }).start();
  }, [step]);

  // ── GPS ────────────────────────────────────────────────────────────────────
  async function handleDetectLocation() {
    setGpsLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please allow location access to auto-fill your area.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setGpsLat(pos.coords.latitude);
      setGpsLng(pos.coords.longitude);

      // Reverse geocode to get a readable address
      const [place] = await Location.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      if (place) {
        const parts = [place.name, place.district, place.city].filter(Boolean);
        setLocationText(parts.join(', '));
      }
    } catch (e) {
      Alert.alert('Could not detect location', 'Enter your service area manually.');
    } finally {
      setGpsLoading(false);
    }
  }

  // ── Go Live ────────────────────────────────────────────────────────────────
  async function handleGoLive() {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (!backendToken) {
        Alert.alert('Connection Error', 'Cannot connect to backend server. Ensure EXPO_PUBLIC_API_URL uses your Mac IP, not localhost when on a real device.');
        return;
      }
      if (!gpsLat || !gpsLng) {
        Alert.alert('Missing Location', 'Please capture your GPS location.');
        return;
      }
      const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';
      const res = await fetch(`${BASE_URL}/me/onboard-pro`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${backendToken}`,
        },
        body: JSON.stringify({
          lat: gpsLat,
          lng: gpsLng,
        })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to onboard (HTTP ${res.status}): ${text}`);
      }

      const data = await res.json();

      // Push location to Redis + set is_available=true so matching engine can find this pro.
      await fetch(`${BASE_URL}/helpers/me/location`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${data.token}`,
        },
        body: JSON.stringify({ lat: gpsLat, lng: gpsLng }),
      });

      // data.token and data.user contain the upgraded profile
      signIn(data.token, data.user);
    } catch (err: any) {
      Alert.alert('Error Details', err.message || 'Network fetch failed completely.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  function nextStep() {
    if (step === 1) {
      // No validation needed for bio
      setStep(2);
    } else if (step === 2) {
      if (selectedServices.length === 0) {
        Alert.alert('Select services', 'Please pick at least one service you offer.');
        return;
      }
      setStep(3);
    } else if (step === 3) {
      if (!locationText.trim()) {
        Alert.alert('Add your area', 'Please enter or detect your service area.');
        return;
      }
      setStep(4);
    }
  }

  function toggleService(id: string) {
    setSelectedServices(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id],
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={s.header}>
          {step > 1 && (
            <TouchableOpacity style={s.backBtn} onPress={() => setStep(s => s - 1)} activeOpacity={0.7}>
              <Text style={s.backBtnText}>←</Text>
            </TouchableOpacity>
          )}
          <View style={{ flex: 1 }}>
            <Text style={s.stepLabel}>Step {step} of {TOTAL_STEPS}</Text>
            <Animated.View style={[s.progressTrack]}>
              <Animated.View
                style={[s.progressFill, {
                  width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                }]}
              />
            </Animated.View>
          </View>
        </View>

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">

          {/* ── Step 1: Bio ─────────────────────────────────────────────────── */}
          {step === 1 && (
            <View style={s.stepContainer}>
              <Text style={s.stepEmoji}>👋</Text>
              <Text style={s.stepTitle}>Hey, tell us about yourself</Text>
              <Text style={s.stepSub}>
                A short intro helps customers feel comfortable booking you.
              </Text>
              <View style={s.inputCard}>
                <TextInput
                  style={s.bioInput}
                  placeholder="I'm an experienced cleaner with 3+ years…"
                  placeholderTextColor={Colors.textMuted}
                  value={bio}
                  onChangeText={setBio}
                  multiline
                  numberOfLines={5}
                  maxLength={250}
                  textAlignVertical="top"
                />
                <Text style={s.charCount}>{bio.length}/250</Text>
              </View>
            </View>
          )}

          {/* ── Step 2: Services ────────────────────────────────────────────── */}
          {step === 2 && (
            <View style={s.stepContainer}>
              <Text style={s.stepEmoji}>🛠️</Text>
              <Text style={s.stepTitle}>What can you do?</Text>
              <Text style={s.stepSub}>Select all the services you are comfortable performing.</Text>
              <View style={s.serviceGrid}>
                {ALL_SERVICES.map(svc => {
                  const selected = selectedServices.includes(svc.id);
                  return (
                    <TouchableOpacity
                      key={svc.id}
                      style={[s.serviceChip, selected && s.serviceChipSelected]}
                      activeOpacity={0.8}
                      onPress={() => toggleService(svc.id)}
                    >
                      <Text style={s.serviceChipEmoji}>{svc.emoji}</Text>
                      <Text style={[s.serviceChipLabel, selected && s.serviceChipLabelSelected]}>
                        {svc.label}
                      </Text>
                      {selected && <Text style={s.serviceChipCheck}>✓</Text>}
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={s.selectedCount}>
                {selectedServices.length} service{selectedServices.length !== 1 ? 's' : ''} selected
              </Text>
            </View>
          )}

          {/* ── Step 3: Location ────────────────────────────────────────────── */}
          {step === 3 && (
            <View style={s.stepContainer}>
              <Text style={s.stepEmoji}>📍</Text>
              <Text style={s.stepTitle}>Where do you work?</Text>
              <Text style={s.stepSub}>
                We match you with customers near your location. Your exact GPS is used for matching — only your area name is shown to customers.
              </Text>

              <TouchableOpacity
                style={[s.gpsButton, gpsLoading && s.gpsButtonLoading]}
                activeOpacity={0.85}
                onPress={handleDetectLocation}
                disabled={gpsLoading}
              >
                {gpsLoading
                  ? <ActivityIndicator size="small" color={Colors.white} />
                  : <Text style={s.gpsButtonText}>📡  Detect My Location</Text>
                }
              </TouchableOpacity>

              {gpsLat != null && (
                <View style={s.gpsBadge}>
                  <Text style={s.gpsBadgeText}>✅  GPS captured</Text>
                </View>
              )}

              <Text style={s.orText}>— or type your area —</Text>

              <View style={s.inputCard}>
                <TextInput
                  style={s.locationInput}
                  placeholder="e.g. Sector 51, Gurugram"
                  placeholderTextColor={Colors.textMuted}
                  value={locationText}
                  onChangeText={setLocationText}
                />
              </View>
            </View>
          )}

          {/* ── Step 4: Review & Go Live ─────────────────────────────────────── */}
          {step === 4 && (
            <View style={s.stepContainer}>
              <Text style={s.stepEmoji}>🚀</Text>
              <Text style={s.stepTitle}>You're all set!</Text>
              <Text style={s.stepSub}>
                Review your profile and hit Go Live to start receiving bookings.
              </Text>

              <View style={s.reviewCard}>
                <ReviewRow label="Services" value={selectedServices.length + ' selected'} />
                <ReviewRow label="Area" value={locationText || '—'} />
                <ReviewRow label="GPS" value={gpsLat != null ? `${gpsLat.toFixed(4)}, ${gpsLng?.toFixed(4)}` : 'Not captured'} />
                {bio ? <ReviewRow label="Bio" value={bio} multiline /> : null}
              </View>

              <View style={s.infoBox}>
                <Text style={s.infoText}>
                  🔔  Once live, you'll receive notifications when a nearby customer needs your service. Accept to confirm.
                </Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* CTA Button */}
        <View style={s.ctaWrap}>
          {step < 4 ? (
            <TouchableOpacity style={s.ctaBtn} activeOpacity={0.88} onPress={nextStep}>
              <Text style={s.ctaBtnText}>Continue  →</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[s.ctaBtn, s.ctaBtnGreen]}
              activeOpacity={0.88}
              onPress={handleGoLive}
              disabled={submitting}
            >
              {submitting
                ? <ActivityIndicator color={Colors.white} />
                : <Text style={s.ctaBtnText}>⚡  Go Live</Text>
              }
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Review Row ────────────────────────────────────────────────────────────────
function ReviewRow({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <View style={s.reviewRow}>
      <Text style={s.reviewLabel}>{label}</Text>
      <Text style={[s.reviewValue, multiline && { flex: 1 }]} numberOfLines={multiline ? 3 : 1}>{value}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 12,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  backBtnText: { fontSize: 20, color: Colors.text },
  stepLabel: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginBottom: 8,
  },
  progressTrack: {
    height: 6,
    backgroundColor: Colors.border,
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
  },

  stepContainer: { paddingHorizontal: 24, paddingTop: 20 },
  stepEmoji: { fontSize: 52, marginBottom: 16 },
  stepTitle: {
    fontFamily: FontFamily.extrabold,
    fontSize: FontSize['2xl'],
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: 10,
  },
  stepSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    lineHeight: 24,
    marginBottom: 28,
  },

  inputCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    padding: 16,
    ...Shadow.sm,
  },
  bioInput: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.text,
    minHeight: 110,
  },
  charCount: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'right',
    marginTop: 8,
  },
  locationInput: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.base,
    color: Colors.text,
    height: 48,
  },

  serviceGrid: {
    gap: 10,
  },
  serviceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    paddingVertical: 16,
    paddingHorizontal: 18,
    gap: 12,
    ...Shadow.sm,
  },
  serviceChipSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryBg,
  },
  serviceChipEmoji: { fontSize: 26 },
  serviceChipLabel: {
    flex: 1,
    fontFamily: FontFamily.medium,
    fontSize: FontSize.base,
    color: Colors.text,
  },
  serviceChipLabelSelected: { color: Colors.primary },
  serviceChipCheck: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.base,
    color: Colors.primary,
  },
  selectedCount: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 16,
  },

  gpsButton: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    paddingVertical: 18,
    alignItems: 'center',
    marginBottom: 14,
    ...Shadow.md,
  },
  gpsButtonLoading: { opacity: 0.75 },
  gpsButtonText: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.base,
    color: Colors.white,
  },
  gpsBadge: {
    backgroundColor: Colors.successBg,
    borderRadius: Radius.full,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 12,
  },
  gpsBadgeText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.success,
  },
  orText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
    marginVertical: 16,
  },

  reviewCard: {
    backgroundColor: Colors.white,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    gap: 16,
    ...Shadow.sm,
    marginBottom: 20,
  },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  reviewLabel: {
    fontFamily: FontFamily.semibold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    width: 70,
  },
  reviewValue: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.text,
    flex: 1,
  },
  infoBox: {
    backgroundColor: Colors.primaryBg,
    borderRadius: Radius.xl,
    padding: 18,
    borderWidth: 1,
    borderColor: `${Colors.primary}22`,
  },
  infoText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.primary,
    lineHeight: 22,
  },

  ctaWrap: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    paddingTop: 12,
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
  ctaBtnGreen: { backgroundColor: Colors.success },
  ctaBtnText: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.white,
    letterSpacing: 0.2,
  },
});
