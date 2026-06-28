// ServiceComplete — post-job view (redesign of TrackLive's inline RatingPanel).
// Mirrors ZopMop_Service_Complete v2: shared SuccessTick + "Service complete!"
// + calm "Paid ₹X" pill + rate-your-pro (5 stars + optional feedback) + Submit/
// Skip, with submitting/submitted states. Both themes.
//
// THEME NOTE: built on useC() (screen.ts) — the design's tokens (--glass,
// --green, --amber-soft, near-black+amber-radial bg) live there and match the
// sibling BookingConfirmed screen. useColors() (theme/colors) is the older slate
// palette with no glass/green tokens, so it can't express this design.
import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet, Dimensions, type TextStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '../theme';
import { useC, type ScreenColors } from '../theme/screen';
import { useTheme } from '../context/ThemeContext';
import { SuccessTick, Confetti, type TickColors } from './SuccessTick';
import { showError } from '../utils/toast';

const { width: SCREEN_W } = Dimensions.get('window');

type Phase = 'rate' | 'submitting' | 'submitted';

type Props = {
  helperName?: string;
  /** Pre-formatted amount, e.g. "₹389". Hidden if absent. */
  priceText?: string;
  /** Performs the API call only (throws on error). */
  onSubmit: (stars: number, comment: string) => Promise<void>;
  /** Called after the thank-you beat to dismiss (e.g. → Bookings). */
  onDone: () => void;
  onSkip: () => void;
};

export default function ServiceComplete({ helperName, priceText, onSubmit, onDone, onSkip }: Props) {
  const c = useC();
  const { isDark } = useTheme();
  const reduced = useReducedMotion();
  const s = React.useMemo(() => makeStyles(c, isDark), [c, isDark]);

  const [phase, setPhase] = useState<Phase>('rate');
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');

  const firstName = helperName ? helperName.split(' ')[0] : 'your pro';
  const avatarInitial = (helperName?.trim()?.[0] ?? 'Z').toUpperCase();
  const busy = phase === 'submitting';
  const canSubmit = stars > 0 && phase === 'rate';

  const submit = async () => {
    if (!canSubmit) return;
    setPhase('submitting');
    try {
      await onSubmit(stars, comment.trim());
      setPhase('submitted');
      setTimeout(onDone, 1500);
    } catch (e) {
      setPhase('rate');
      showError((e as Error)?.message ?? 'Could not submit rating');
    }
  };

  const tickColors: Partial<TickColors> | undefined = isDark
    ? undefined // defaults already match the dark mockup
    : {
        orbTop: '#34D278',
        orbBottom: '#15803D',
        dash: 'rgba(22,163,74,0.30)',
        solid: 'rgba(22,163,74,0.40)',
        pulse: 'rgba(22,163,74,0.32)',
        shadow: '#16A34A',
      };
  // ── Submitted: thank-you + mini stars echoing the rating ──
  if (phase === 'submitted') {
    return (
      <View style={s.thanks}>
        <Text style={[fontExtra, s.thanksTitle]}>Thanks for the feedback!</Text>
        <Text style={[fontMed, s.thanksSub]}>It helps us keep ZopMop pros top-notch.</Text>
        <View style={s.miniStars}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Feather key={n} name="star" size={20} color={n <= stars ? c.amber : s.starEmpty.color} />
          ))}
        </View>
      </View>
    );
  }

  // ── Complete + rate (also the submitting state) ──
  return (
    <View style={s.root}>
      {/* Confetti bursts from above the tick (same dots/colors/anim as BookingConfirmed),
          anchored to a local box so it surrounds the centered tick. */}
      {!reduced && (
        <View pointerEvents="none" style={s.confettiAnchor}>
          <Confetti boxW={SCREEN_W} boxH={SCREEN_W * 1.1} />
        </View>
      )}

      <View style={s.stage}>
        <SuccessTick colors={tickColors} sizeScale={1.2} />

        <Text style={[fontExtra, s.headline]}>Service complete!</Text>
        <Text style={[fontMed, s.subhead]}>Hope {firstName} did a sparkling job.</Text>

        {!!priceText && (
          <View style={s.paid}>
            <View style={s.paidDot}>
              <Feather name="check" size={11} color="#FFFFFF" />
            </View>
            {/* TODO(cash-variant): mockup also has "Paid ₹X · Cash". Blocked on
                booking-detail exposing payment_method/cash_collected_at (the pro
                app already reads these). Wire the " · Cash" suffix when available. */}
            <Text style={[fontSemi, s.paidText]}>Paid {priceText}</Text>
          </View>
        )}
      </View>

      <View style={s.rateCard}>
        <View style={s.whoRow}>
          <View style={s.avatar}>
            <Text style={[fontBold, s.avatarText]}>{avatarInitial}</Text>
          </View>
          <Text style={[fontBold, s.prompt]}>Rate {firstName}</Text>
        </View>

        <View style={s.starsRow}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable key={n} onPress={() => setStars(n)} hitSlop={6} disabled={busy}>
              <Feather name="star" size={32} color={n <= stars ? c.amber : s.starEmpty.color} />
            </Pressable>
          ))}
        </View>

        <TextInput
          style={s.field}
          placeholder="Add your feedback (optional)"
          placeholderTextColor={c.textMuted}
          value={comment}
          onChangeText={setComment}
          editable={!busy}
          multiline
          maxLength={500}
        />
      </View>

      <View style={s.ctaWrap}>
        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          style={[s.cta, !canSubmit && !busy && { opacity: 0.45 }, busy && { opacity: 0.92 }]}
        >
          {busy ? (
            <>
              <ActivityIndicator size="small" color="#3a2600" />
              <Text style={[fontBold, s.ctaText]}>Submitting…</Text>
            </>
          ) : (
            <Text style={[fontBold, s.ctaText]}>Submit rating</Text>
          )}
        </Pressable>
        <Pressable onPress={onSkip} hitSlop={6} disabled={busy} style={busy && { opacity: 0.4 }}>
          <Text style={[fontSemi, s.skip]}>Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

const fontMed: TextStyle = { fontFamily: FontFamily.medium };
const fontSemi: TextStyle = { fontFamily: FontFamily.semibold };
const fontBold: TextStyle = { fontFamily: FontFamily.bold };
const fontExtra: TextStyle = { fontFamily: FontFamily.extrabold };

function makeStyles(c: ScreenColors, isDark: boolean) {
  // --star-empty has no useC token; documented literal per mockup.
  const starEmptyColor = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(13,13,15,0.16)';
  return StyleSheet.create({
    root: { paddingTop: 8, paddingHorizontal: 6, paddingBottom: 8 },
    // Full-width burst around the tick (matches BookingConfirmed's screen-wide spread).
    confettiAnchor: { position: 'absolute', top: -40, left: -6, width: SCREEN_W, height: SCREEN_W * 1.1 },
    stage: { alignItems: 'center', paddingHorizontal: 20 },

    // marginTop clears the tick's halo overflow (halo extends ~16px below the
    // 152 wrap; the light white-core halo otherwise washes out the headline).
    headline: { fontSize: 25, letterSpacing: -0.5, color: c.text, marginTop: 30, textAlign: 'center' },
    subhead: { fontSize: 14, color: c.textMuted, marginTop: 6, textAlign: 'center' },

    paid: {
      marginTop: 14,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: c.successSoft,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(34,197,94,0.45)' : 'rgba(22,163,74,0.40)',
    },
    paidDot: {
      width: 18, height: 18, borderRadius: 9,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.green,
    },
    paidText: { fontSize: 14, color: c.text },

    rateCard: {
      marginTop: 24,
      width: '100%',
      backgroundColor: c.glass,
      borderWidth: 1,
      borderColor: c.glassBorder,
      borderRadius: 24,
      padding: 20,
      alignItems: 'center',
    },
    whoRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 16 },
    avatar: {
      width: 42, height: 42, borderRadius: 21,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.amberHi,
    },
    avatarText: { fontSize: 15, color: '#3a2600' },
    prompt: { fontSize: 17, color: c.text, letterSpacing: -0.2 },

    starsRow: { flexDirection: 'row', gap: 10, marginBottom: 18 },
    starEmpty: { color: starEmptyColor },

    field: {
      width: '100%',
      minHeight: 52,
      borderRadius: 14,
      backgroundColor: c.glassHi,
      borderWidth: 1,
      borderColor: c.glassBorder,
      paddingHorizontal: 16,
      paddingVertical: 14,
      textAlignVertical: 'top',
      fontSize: 14,
      color: c.text,
      fontFamily: FontFamily.medium,
    },

    ctaWrap: { width: '100%', alignItems: 'center', gap: 12, paddingTop: 18, paddingBottom: 6 },
    cta: {
      width: '100%',
      height: 54,
      borderRadius: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      backgroundColor: c.amber,
    },
    ctaText: { fontSize: 16, color: '#3a2600', letterSpacing: 0.1 },
    skip: { fontSize: 14, color: c.textSecondary, paddingHorizontal: 10, paddingVertical: 4 },

    // Submitted state
    thanks: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, paddingVertical: 40 },
    thanksTitle: { fontSize: 25, letterSpacing: -0.5, color: c.text, marginTop: 22, textAlign: 'center' },
    thanksSub: { fontSize: 14.5, color: c.textMuted, marginTop: 9, textAlign: 'center' },
    miniStars: { flexDirection: 'row', gap: 6, marginTop: 18 },
  });
}
