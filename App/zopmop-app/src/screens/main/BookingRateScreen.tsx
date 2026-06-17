// BookingRateScreen — dark home pattern.
//
// Triggered automatically once a booking moves to 'completed' (auto-show
// guarded by ratedBookingsStore so the same booking only ever asks once)
// + accessible by tapping a completed card on the past bookings tab.
//
// After Submit:
//   1. POST /bookings/:id/rate (backend stub — non-fatal on 404)
//   2. If helper isn't already an expert AND user has < 5, surface
//      "Add [name] to Your Experts?" card
//   3. Tap "Add Expert" → POST /me/experts/:helper_id, success toast, close
//   4. Tap "Not now" → close

import React, { useMemo, useState } from 'react';
import {
  
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
} from 'react-native';
import { LoadingBars } from '../../components/ui/LoadingBars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';

import type { MainStackParamList } from '../../types/navigation';
import { useAuth } from '../../context/AuthContext';
import { rateBooking } from '../../api/bookings';
import { addExpert, listExperts } from '../../api/experts';
import { PrimaryButton } from '../../components/PrimaryButton';
import { haptics } from '../../utils/haptics';
import { showError, showSuccess } from '../../utils/toast';
import { markBookingRated } from '../../utils/ratedBookingsStore';
import { usePostHog } from 'posthog-react-native';

import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';
import { Bloom } from '../../components/home/Bloom';
import { GlassCard } from '../../components/home/GlassCard';
import { PressFx } from '../../components/ui/PressFx';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontSemi:  TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const H_PAD = 20;

type Props = { route: RouteProp<MainStackParamList, 'BookingRate'> };
type Nav = NativeStackNavigationProp<MainStackParamList>;

export default function BookingRateScreen({ route }: Props) {
  const { isDark } = useTheme();
  const c = useC();
  const s = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const { bookingId, helperId, helperName } = route.params;
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const posthog = usePostHog();

  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showExpertPrompt, setShowExpertPrompt] = useState(false);
  const [addingExpert, setAddingExpert] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  function pickStar(n: number) {
    haptics.selection();
    setStars(n);
    if (errorMessage) setErrorMessage('');
  }

  async function handleSubmit() {
    if (stars === 0) {
      setErrorMessage('Tap a star to rate.');
      return;
    }
    if (!token) return;
    haptics.medium();
    setSubmitting(true);
    setErrorMessage('');
    try {
      const res = await rateBooking(token, bookingId, {
        stars,
        comment: comment.trim() || undefined,
      });
      if (!res.ok && res.statusCode !== 404) {
        setErrorMessage('Could not save rating. Please try again.');
        setSubmitting(false);
        return;
      }
      await markBookingRated(bookingId);
      posthog.capture('booking_rated', {
        booking_id: bookingId,
        stars,
        has_comment: comment.trim().length > 0,
        helper_id: helperId ?? null,
      });
      setSubmitted(true);

      if (helperId && helperId !== '' && stars >= 4) {
        try {
          const list = await listExperts(token);
          const already = list.experts.some((e) => e.helper_id === helperId);
          if (!already && list.experts.length < list.limit) {
            setShowExpertPrompt(true);
            return;
          }
        } catch {
          // swallow — just close
        }
      }
      showSuccess('Thanks for rating.');
      setTimeout(() => navigation.goBack(), 600);
    } catch (err) {
      // Network/timeout/non-OK rejection from rateBooking — without this the
      // spinner just stops and the user sees nothing.
      setErrorMessage(err instanceof Error ? err.message : 'Could not save rating. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddExpert() {
    if (!token || !helperId) return;
    haptics.heavy();
    setAddingExpert(true);
    try {
      await addExpert(token, helperId);
      posthog.capture('expert_added', { helper_id: helperId });
      showSuccess(`${helperName ?? 'Pro'} added to Your Experts.`);
      setTimeout(() => navigation.goBack(), 600);
    } catch (err: any) {
      showError(err?.message ?? 'Could not add expert.');
      setAddingExpert(false);
    }
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Bloom />

      <View style={[s.head, { paddingTop: insets.top + 10 }]}>
        <View style={s.headRow}>
          <PressFx onPress={() => navigation.goBack()} style={s.iconBtn}>
            <Feather name="chevron-left" size={18} color={c.text} />
          </PressFx>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Rate your pro</Text>
            <Text style={s.sub}>How did the service feel?</Text>
          </View>
        </View>
      </View>

      <View style={s.proCard}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>
            {(helperName ?? '?').slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <Text style={s.proName}>{helperName ?? 'Your pro'}</Text>
      </View>

      {!showExpertPrompt ? (
        <>
          <View style={s.starsRow}>
            {[1, 2, 3, 4, 5].map((n) => (
              <PressFx key={n} onPress={() => pickStar(n)} style={s.starBtn}>
                <Text
                  style={[
                    s.starGlyph,
                    n <= stars ? s.starGlyphOn : s.starGlyphOff,
                  ]}
                >
                  ★
                </Text>
              </PressFx>
            ))}
          </View>

          <View style={s.commentWrap}>
            <TextInput
              value={comment}
              onChangeText={setComment}
              placeholder="Add a note (optional)"
              placeholderTextColor={c.textMuted}
              style={s.commentInput}
              multiline
              maxLength={400}
              editable={!submitting && !submitted}
            />
          </View>

          {!!errorMessage && <Text style={s.errorText}>{errorMessage}</Text>}

          <View style={s.cta}>
            <PrimaryButton
              label={submitting ? 'Saving…' : 'Submit'}
              onPress={handleSubmit}
              isLoading={submitting}
              disabled={submitting || submitted}
            />
          </View>
        </>
      ) : (
        <GlassCard radius={22} hero style={s.expertCard}>
          <View style={s.expertIcon}>
            <Feather name="award" size={26} color={c.amber} />
          </View>
          <Text style={s.expertTitle}>
            Add {helperName ?? 'this pro'} to Your Experts?
          </Text>
          <Text style={s.expertSub}>
            They'll get first pick of your future bookings — your favourite pros are tried first.
          </Text>
          <View style={s.expertCtas}>
            <PressFx
              style={s.notNowBtn}
              onPress={() => navigation.goBack()}
              disabled={addingExpert}
            >
              <Text style={s.notNowText}>Not now</Text>
            </PressFx>
            <View style={{ flex: 1 }}>
              <PrimaryButton
                label={addingExpert ? 'Adding…' : 'Add Expert'}
                onPress={handleAddExpert}
                isLoading={addingExpert}
                disabled={addingExpert}
              />
            </View>
          </View>
        </GlassCard>
      )}

      {submitting && !showExpertPrompt ? (
        <View style={s.loadingOverlay}>
          <LoadingBars color={c.amber} />
        </View>
      ) : null}

      <View style={{ height: insets.bottom }} />
    </View>
  );
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors
// slate). Dark stays #0A0A0A + amber #F5A300 identical; light adds the cream bg
// + amber. Color-only migration — layout, copy, fonts, and logic unchanged.
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Empty star: dark keeps the very faint white tick (no useC equivalent);
  // light uses a faint ink tick so unselected stars stay barely visible.
  const starOff = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(13,13,15,0.18)';
  // Loading scrim sits over the screen bg → tint to match each theme's bg.
  const scrim = isDark ? 'rgba(10,10,10,0.4)' : 'rgba(250,247,242,0.55)';
  // Ink on the amber avatar — theme-independent (avatar is amber in both).
  const onAmber = '#0A0A0A';
  // "Not now" outline button: dark keeps its exact original white tint
  // (0.15 border / 0.04 fill, slightly stronger than the glass tokens);
  // light uses the ink-based glass tokens so it reads on cream.
  const notNowBorder = isDark ? 'rgba(255,255,255,0.15)' : c.glassBorderHi;
  const notNowFill = isDark ? 'rgba(255,255,255,0.04)' : c.glass;

  return StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },

  head: { paddingHorizontal: H_PAD, paddingBottom: 14 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.glassHi,
    borderWidth: 0.5, borderColor: c.glassBorderHi,
  },
  title: {
    ...fontExtra,
    fontSize: 24, color: c.text,
    letterSpacing: -0.6, lineHeight: 28,
  },
  sub: {
    ...fontMed,
    fontSize: 12, color: c.textMuted,
    marginTop: 2,
  },

  proCard: {
    alignItems: 'center',
    paddingVertical: 22,
    gap: 12,
  },
  avatar: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: c.amber,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: {
    ...fontExtra,
    fontSize: 32,
    color: onAmber,
  },
  proName: {
    ...fontBold,
    fontSize: 17, color: c.text,
    letterSpacing: -0.3,
  },

  starsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginVertical: 8,
  },
  starBtn: {
    width: 48, height: 48,
    alignItems: 'center', justifyContent: 'center',
  },
  starGlyph: { fontSize: 38, lineHeight: 42 },
  starGlyphOn: { color: c.amber },
  starGlyphOff: { color: starOff },

  commentWrap: { paddingHorizontal: H_PAD, marginTop: 10 },
  commentInput: {
    minHeight: 88,
    backgroundColor: c.glass,
    borderRadius: 16,
    padding: 14,
    ...fontMed,
    fontSize: 14,
    color: c.text,
    textAlignVertical: 'top',
    borderWidth: 0.5,
    borderColor: c.glassBorder,
  },

  errorText: {
    ...fontSemi,
    fontSize: 12, color: c.danger,
    paddingHorizontal: H_PAD + 4,
    marginTop: 10,
  },

  cta: { paddingHorizontal: H_PAD, paddingTop: 22 },

  expertCard: {
    marginHorizontal: H_PAD,
    padding: 22,
    alignItems: 'center',
    gap: 12,
  },
  expertIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(245,163,0,0.12)',
    borderWidth: 1, borderColor: 'rgba(245,163,0,0.32)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 2,
  },
  expertTitle: {
    ...fontExtra,
    fontSize: 17, color: c.text,
    textAlign: 'center', letterSpacing: -0.3,
  },
  expertSub: {
    ...fontMed,
    fontSize: 13, color: c.textSecondary,
    textAlign: 'center', lineHeight: 19,
  },
  expertCtas: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    marginTop: 8,
  },
  notNowBtn: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: notNowBorder,
    backgroundColor: notNowFill,
    justifyContent: 'center',
  },
  notNowText: {
    ...fontBold,
    fontSize: 13.5, color: c.text,
  },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: scrim,
  },
  });
}
