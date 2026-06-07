export const lightColors = {
  primary: '#4F46E5',      // Electric Indigo
  primaryLight: '#818CF8', // Indigo 400
  primaryBg: '#EEF2FF',   // Indigo 50
  accent: '#F5A300',       // ZopMop amber
  accentLight: '#FFC042',  // ZopMop amber-hi
  accentOnSurface: '#B37100',  // Amber text sitting directly on cream bg (no chip/card behind it) — kicker labels only

  // Neutral
  background: '#FAF7F2',   // Warm cream (top of light bg gradient)
  white: '#FFFFFF',
  text: '#0D0D0F',         // Ink — primary text on cream
  textSecondary: 'rgba(13,13,15,0.65)',
  textMuted: 'rgba(13,13,15,0.50)',
  border: 'rgba(13,13,15,0.06)',
  surface: '#FFFFFF',

  // Status
  warning: '#F59E0B',
  warningBg: '#FEF3C7',
  success: '#059669',
  successBg: '#D1FAE5',
  danger: '#DC2626',
  dangerBg: '#FEE2E2',
  info: '#3B82F6',
  infoBg: '#DBEAFE',

  // Booking status colors
  status: {
    pending: '#F59E0B',
    accepted: '#3B82F6',
    in_progress: '#4F46E5',
    completed: '#059669',
    cancelled: '#DC2626',
  },
} as const;

export const darkColors = {
  primary: '#818CF8',      // Indigo 400 — brighter on dark
  primaryLight: '#A5B4FC', // Indigo 300
  primaryBg: '#1E1B4B',   // Indigo 950

  accent: '#FFC042',       // ZopMop amber-hi (brighter on dark)
  accentLight: '#FFD980',  // ZopMop amber-glow
  accentOnSurface: '#F5A300',  // Same as accent — already readable on dark surfaces

  // Neutral
  background: '#0F172A',   // Slate 900
  white: '#1E293B',        // Slate 800 — "white" surfaces in dark
  text: '#F1F5F9',         // Slate 100
  textSecondary: '#94A3B8', // Slate 400
  textMuted: '#64748B',    // Slate 500
  border: '#334155',       // Slate 700
  surface: '#1E293B',      // Slate 800

  // Status
  warning: '#FCD34D',
  warningBg: '#451A03',
  success: '#34D399',
  successBg: '#064E3B',
  danger: '#F87171',
  dangerBg: '#450A0A',
  info: '#60A5FA',
  infoBg: '#1E3A5F',

  // Booking status colors
  status: {
    pending: '#FCD34D',
    accepted: '#60A5FA',
    in_progress: '#818CF8',
    completed: '#34D399',
    cancelled: '#F87171',
  },
} as const;

// Default export keeps existing imports working — they always get light theme.
// Components that support dark mode use useColors() from ThemeContext instead.
export const Colors = lightColors;
