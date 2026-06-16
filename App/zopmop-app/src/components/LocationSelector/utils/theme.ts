import { C } from '../../../theme/screen';

const lightTokens = {
  bg: '#FAF7F2',
  sheetBg: '#FFFFFF',
  sheetBgEnd: '#FAF7F1',
  text: '#0D0D0F',
  textSecondary: 'rgba(13,13,15,0.65)',
  textMuted: 'rgba(13,13,15,0.45)',
  border: 'rgba(13,13,15,0.10)',
  borderStrong: 'rgba(13,13,15,0.18)',
  divider: 'rgba(13,13,15,0.07)',
  glass: 'rgba(13,13,15,0.03)',
  glassHi: 'rgba(13,13,15,0.04)',
  glassBorder: 'rgba(13,13,15,0.07)',
  glassBorderHi: 'rgba(13,13,15,0.10)',
  surface: '#FFFFFF',
  surfaceShadow: 'rgba(13,13,15,0.03)',
  scrim: 'rgba(40,30,15,0.28)',
  amber: '#F5A300',
  amberHi: '#B37100',
  amberFill: 'rgba(245,163,0,0.12)',
  amberBorder: 'rgba(245,163,0,0.28)',
  amberGlow: 'rgba(245,163,0,0.18)',
  danger: '#EF4444',
  dangerFill: 'rgba(239,68,68,0.15)',
  ink: '#0D0D0F',
  white: '#FFFFFF',
  toggleOff: 'rgba(13,13,15,0.12)',
  mapRoad: 'rgba(255,255,255,0.80)',
  mapGrid: 'rgba(13,13,15,0.07)',
  mapBg: '#EDE8DC',
  pinStroke: '#FFFFFF',
} as const;

const darkTokens = {
  bg: C.bg,
  sheetBg: '#1E1E20',
  sheetBgEnd: '#131315',
  text: '#FFFFFF',
  textSecondary: 'rgba(255,255,255,0.65)',
  textMuted: 'rgba(255,255,255,0.45)',
  border: 'rgba(255,255,255,0.10)',
  borderStrong: 'rgba(255,255,255,0.18)',
  divider: 'rgba(255,255,255,0.08)',
  glass: 'rgba(255,255,255,0.05)',
  glassHi: 'rgba(255,255,255,0.07)',
  glassBorder: 'rgba(255,255,255,0.08)',
  glassBorderHi: 'rgba(255,255,255,0.12)',
  surface: 'rgba(255,255,255,0.045)',
  surfaceShadow: 'rgba(0,0,0,0.35)',
  scrim: 'rgba(0,0,0,0.45)',
  amber: '#F5A300',
  amberHi: '#FFC042',
  amberFill: 'rgba(245,163,0,0.14)',
  amberBorder: 'rgba(245,163,0,0.35)',
  amberGlow: 'rgba(245,163,0,0.25)',
  danger: '#EF4444',
  dangerFill: 'rgba(239,68,68,0.10)',
  ink: '#0A0A0A',
  white: '#FFFFFF',
  toggleOff: 'rgba(255,255,255,0.12)',
  mapRoad: 'rgba(255,255,255,0.06)',
  mapGrid: 'rgba(255,255,255,0.04)',
  mapBg: '#0D0D10',
  pinStroke: '#0A0A0A',
} as const;

export type LSThemeTokens = {
  [K in keyof typeof darkTokens]: string;
};

export function getThemeTokens(isDark: boolean): LSThemeTokens {
  return isDark ? darkTokens : lightTokens;
}
