// OTPInput — N-box per-digit code input matching the Phase 1 pro/customer
// service OTP mockups. Reused for both the Start OTP (Phase 1 Step 4 State A)
// and the End OTP (Step 4 State D); the customer-side TrackLive read-only
// display (Step 5) does not use this component because it's display-only.
//
// Visual tokens come from ZopMop_Pro_Job_Detail.html (.otp .box):
//
//   box           56 x 64, radius 14, monospace 28px/800/-.02em
//   idle dark     bg rgba(255,255,255,.045), border 1.5px rgba(255,255,255,.10)
//   idle light    bg #fff,                   border 1.5px rgba(13,13,15,.10)
//   filled        border #F5A300, fill rgba(245,163,0,.06) (dark) / #FFF8EA (light)
//   active        border #F5A300, halo 4px rgba(245,163,0,.18)
//   error (.err)  border #F87171 (replaces amber, applied to ALL boxes when set)
//
// Backend (internal/otp) generates 6-digit codes via generateCode (%06d).
// The default length matches; we keep it parameterised so the same component
// covers any future scope change in one place.

import React, { useCallback, useEffect, useRef } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
  ViewStyle,
} from 'react-native';
import { useColors, useTheme } from '../../context/ThemeContext';

export interface OTPInputProps {
  /** Total digit count. Backend issues 6-digit codes; default 6. */
  length?: number;
  /** Current value. Parent owns state; supply via useState. */
  value: string;
  /** Fired on every change. Always a string of digits, length <= props.length. */
  onChange: (next: string) => void;
  /** Fired when value reaches full length. Wire submission here. */
  onComplete?: (code: string) => void;
  /** When true, all boxes render with the error border. Use after a failed
   *  verify so the user sees the input was rejected, then clear on retry. */
  error?: boolean;
  /** Disables editing (e.g. while submission is in flight). */
  disabled?: boolean;
  /** Auto-focus the first empty box on mount. Default true. */
  autoFocus?: boolean;
  /** Wrapper style override. */
  style?: ViewStyle;
}

const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function OTPInput({
  length = 6,
  value,
  onChange,
  onComplete,
  error = false,
  disabled = false,
  autoFocus = true,
  style,
}: OTPInputProps) {
  // Theme access in Phase 1 uses useColors() for semantic tokens and
  // useTheme().isDark only where a raw boolean is needed (here, for
  // picking between the two mockup tint variants that don't map to
  // current useColors() vocabulary — see
  // App/househelp-api/docs/phase-1-payment-gated-flow.md).
  const c = useColors();
  const { isDark } = useTheme();
  const inputRef = useRef<TextInput | null>(null);

  // Activate the next-empty box on every value change so the caret-style
  // halo tracks where the user is.
  const activeIndex = Math.min(value.length, length - 1);

  useEffect(() => {
    if (autoFocus && !disabled) {
      // Defer to next tick to let the parent mount/transition settle.
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [autoFocus, disabled]);

  const handleChangeText = useCallback(
    (raw: string) => {
      if (disabled) return;
      // Strip everything but digits and clamp to length.
      const cleaned = raw.replace(/[^0-9]/g, '').slice(0, length);
      onChange(cleaned);
      if (cleaned.length === length) {
        onComplete?.(cleaned);
      }
    },
    [disabled, length, onChange, onComplete],
  );

  const focus = () => inputRef.current?.focus();

  // Box backgrounds + borders branch on (filled, active, error) state.
  // The glass / amber-tint literals here are mockup-spec tints not
  // present in the current useColors() vocabulary; they migrate to
  // useC().glass / amberSoft / amberLine etc. when the appearance-
  // toast branch lands. Tracked in phase-1-payment-gated-flow.md.
  const idleBg = isDark ? 'rgba(255,255,255,0.045)' : '#FFFFFF';
  const idleBorder = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(13,13,15,0.10)';
  const filledBg = isDark ? 'rgba(245,163,0,0.06)' : '#FFF8EA';
  const amber = '#F5A300';
  const errorBorder = '#F87171';
  // Digit color IS a semantic token, so it comes from useColors().
  const digitColor = c.text;

  return (
    <TouchableWithoutFeedback onPress={focus}>
      <View style={[styles.row, style]}>
        {Array.from({ length }).map((_, i) => {
          const digit = value[i] ?? '';
          const filled = digit !== '';
          const active = !error && !disabled && i === activeIndex && value.length < length;
          const border = error ? errorBorder : filled || active ? amber : idleBorder;
          const bg = filled ? filledBg : idleBg;
          const shadow = active
            ? Platform.select({
                ios: { shadowColor: amber, shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
                android: { elevation: 0 },
              })
            : null;
          return (
            <View
              key={i}
              style={[
                styles.box,
                {
                  backgroundColor: bg,
                  borderColor: border,
                  borderWidth: 1.5,
                },
                shadow as ViewStyle,
              ]}
            >
              <Text style={[styles.digit, { color: digitColor, fontFamily: MONO_FONT }]}>
                {digit}
              </Text>
            </View>
          );
        })}
        {/* Hidden TextInput captures the keyboard; visual boxes are read-only
            decorations driven by `value`. One input keeps autofill (iOS SMS
            one-time-code), paste, and IME behaviours simple — far less
            failure surface than per-box TextInputs. */}
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleChangeText}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
          maxLength={length}
          editable={!disabled}
          caretHidden
          style={styles.hidden}
          // Avoid iOS auto-correction underline ghosting through into our
          // visual boxes on dark mode.
          autoCorrect={false}
          spellCheck={false}
        />
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginVertical: 6,
  },
  box: {
    width: 56,
    height: 64,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  digit: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});

export default OTPInput;
