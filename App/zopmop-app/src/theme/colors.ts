export const lightColors = {
  primary: '#4F46E5',      // Electric Indigo
  primaryLight: '#818CF8', // Indigo 400
  primaryBg: '#EEF2FF',   // Indigo 50
  accent: '#0D9488',       // Teal
  accentLight: '#5EEAD4',  // Teal 300

  // Neutral
  background: '#FAFAFA',
  white: '#FFFFFF',
  text: '#111827',         // Gray 900
  textSecondary: '#6B7280', // Gray 500
  textMuted: '#9CA3AF',    // Gray 400
  border: '#E5E7EB',       // Gray 200
  surface: '#F9FAFB',      // Gray 50

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

  accent: '#14B8A6',       // Teal 500
  accentLight: '#5EEAD4',  // Teal 300

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
