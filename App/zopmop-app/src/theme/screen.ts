// Shared dark-screen tokens. Every dark-mode screen pulls C from here so the
// palette stays 100% consistent. Don't add screen-specific colors — keep this
// file as the single source of truth for the migrated dark UI.

export const C = {
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
