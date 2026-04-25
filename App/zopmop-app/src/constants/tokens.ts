// Single source of truth for design tokens.
// Mirrors src/theme/ (kept in place for legacy/onboarding StyleSheet usage)
// and tailwind.config.js (NativeWind class names). All three must stay in sync.

import { Easing } from 'react-native-reanimated';

export { lightColors, darkColors, Colors } from '../theme/colors';
export { FontFamily, FontSize, LineHeight } from '../theme/typography';
export { Spacing, Radius, Shadow } from '../theme';

// ── Motion tokens (Reanimated / Moti) ────────────────────────────────────────
// GSAP-style timeline values translated to Reanimated easing curves.
export const Motion = {
  // Durations (ms)
  duration: {
    instant: 120,
    quick: 180,
    base: 240,
    slow: 380,
    deliberate: 520,
    intro: 800,
  },
  // Easing curves — cubic-bezier equivalents of common GSAP eases
  easing: {
    standard: Easing.bezier(0.4, 0, 0.2, 1),       // material standard
    enter: Easing.bezier(0.0, 0, 0.2, 1),          // material decelerate
    exit: Easing.bezier(0.4, 0, 1, 1),             // material accelerate
    spring: Easing.bezier(0.34, 1.56, 0.64, 1),    // overshoot bounce
    bounce: Easing.bezier(0.68, -0.55, 0.265, 1.55),
    smooth: Easing.bezier(0.65, 0, 0.35, 1),       // expo inOut
    back: Easing.bezier(0.5, -0.25, 0.5, 1.25),    // backOut
  },
  // Spring presets (Reanimated withSpring)
  spring: {
    bouncy: { damping: 10, stiffness: 180, mass: 0.6 },
    snappy: { damping: 18, stiffness: 240, mass: 0.7 },
    gentle: { damping: 22, stiffness: 140, mass: 0.9 },
    stiff: { damping: 26, stiffness: 320, mass: 0.6 },
  },
  // Stagger intervals for list entrances
  stagger: {
    tight: 40,
    base: 60,
    spread: 90,
  },
} as const;

// ── Z-index scale ────────────────────────────────────────────────────────────
export const Z = {
  base: 0,
  raised: 1,
  sticky: 10,
  overlay: 50,
  modal: 100,
  toast: 200,
} as const;

// ── Touch target minimums (a11y) ─────────────────────────────────────────────
export const Touch = {
  min: 44, // iOS HIG minimum
  comfy: 48,
  large: 56,
} as const;
