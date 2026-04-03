export const Colors = {
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
