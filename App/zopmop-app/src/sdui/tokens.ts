// SDUI design tokens. Server references these via ColorToken / radius keys;
// renderer maps tokens → concrete RN style values.
// Both light + dark variants. Resolve at render time using current theme.

import type { ColorToken } from './types';

type ThemeMode = 'light' | 'dark';

const LIGHT_COLORS: Record<ColorToken, string> = {
  'brand-primary':   '#4F46E5',
  'brand-secondary': '#F5A300',
  'surface':         '#FFFFFF',
  'surface-alt':     '#F9FAFB',
  'text-primary':    '#111827',
  'text-muted':      '#6B7280',
  'border':          '#E5E7EB',
};

const DARK_COLORS: Record<ColorToken, string> = {
  'brand-primary':   '#818CF8',
  'brand-secondary': '#FFC042',
  'surface':         '#1E293B',
  'surface-alt':     '#0F172A',
  'text-primary':    '#F1F5F9',
  'text-muted':      '#94A3B8',
  'border':          '#334155',
};

export function resolveColor(token: ColorToken | undefined, mode: ThemeMode = 'light'): string | undefined {
  if (!token) return undefined;
  return (mode === 'dark' ? DARK_COLORS : LIGHT_COLORS)[token];
}

export const RADIUS_TOKENS = {
  sm:   8,
  md:   12,
  lg:   20,
  full: 9999,
} as const;

export type RadiusToken = keyof typeof RADIUS_TOKENS;

export function resolveRadius(token: RadiusToken | undefined): number | undefined {
  return token ? RADIUS_TOKENS[token] : undefined;
}

// Spacing scale — used by the renderer if needed; layout numbers come straight from
// SduiLayout (server passes pixel values), so this is mostly informational.
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const TYPOGRAPHY = {
  bodyFamily:    'PlusJakartaSans_400Regular',
  semiFamily:    'PlusJakartaSans_600SemiBold',
  boldFamily:    'PlusJakartaSans_700Bold',
  extraFamily:   'PlusJakartaSans_800ExtraBold',
} as const;
