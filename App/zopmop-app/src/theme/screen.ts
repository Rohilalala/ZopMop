// Post-pilot: migrate all consumers from useC() to useColors() and delete this file.
//
// Shared screen tokens. Dark-mode screens originally imported the static `C`
// object. The `useC()` hook returns the correct palette for the active theme
// so existing token names (`C.glass`, `C.glassBorder`, etc.) work in both
// modes without renaming every callsite.
//
// Static `C` is kept as a re-export of `darkC` so non-component code (e.g.
// StyleSheet.create at module scope) doesn't break during incremental migration.

import { useTheme } from '../context/ThemeContext';

const darkC = {
  bg: '#0A0A0A',
  amber: '#F5A300',
  amberHi: '#FFC042',
  amberLo: '#E88F00',
  ink: '#0D0D0F',
  white: '#FFFFFF',
  green: '#22C55E',
  danger: '#EF4444',
  upiPurple: '#5F259F',
  paytmBlue: '#00BAF2',

  text: '#FFFFFF',
  textMuted: 'rgba(255,255,255,0.45)',
  textSecondary: 'rgba(255,255,255,0.65)',

  glass: 'rgba(255,255,255,0.045)',
  glassHi: 'rgba(255,255,255,0.06)',
  glassBorder: 'rgba(255,255,255,0.07)',
  glassBorderHi: 'rgba(255,255,255,0.12)',
  divider: 'rgba(255,255,255,0.06)',
  amberSoft: 'rgba(245,163,0,0.12)',
  amberLine: 'rgba(245,163,0,0.4)',

  successSoft: 'rgba(34,197,94,0.14)',
  dangerSoft: 'rgba(239,68,68,0.10)',
  dangerBorder: 'rgba(239,68,68,0.25)',
} as const;

const lightC = {
  bg: '#FAF7F2',
  amber: '#F5A300',
  amberHi: '#FFC042',
  amberLo: '#E88F00',
  ink: '#0D0D0F',
  white: '#FFFFFF',
  green: '#16A34A',
  danger: '#DC2626',
  upiPurple: '#5F259F',
  paytmBlue: '#00BAF2',

  text: '#0D0D0F',
  textMuted: 'rgba(13,13,15,0.50)',
  textSecondary: 'rgba(13,13,15,0.65)',

  glass: 'rgba(255,255,255,0.65)',
  glassHi: 'rgba(255,255,255,0.75)',
  glassBorder: 'rgba(13,13,15,0.06)',
  glassBorderHi: 'rgba(13,13,15,0.06)',
  divider: 'rgba(13,13,15,0.06)',
  amberSoft: 'rgba(245,163,0,0.10)',
  amberLine: 'rgba(245,163,0,0.35)',

  successSoft: 'rgba(5,150,105,0.10)',
  dangerSoft: 'rgba(220,38,38,0.08)',
  dangerBorder: 'rgba(220,38,38,0.20)',
} as const;

export type ScreenColors = { readonly [K in keyof typeof darkC]: string };

export function useC(): ScreenColors {
  const { isDark } = useTheme();
  return isDark ? darkC : lightC;
}

export const C = darkC;
