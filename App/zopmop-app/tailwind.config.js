/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // ZopMop brand — mirrors src/theme/colors.ts (single source of truth: theme/)
        primary: {
          DEFAULT: '#4F46E5',
          light: '#818CF8',
          bg: '#EEF2FF',
          50: '#EEF2FF',
          100: '#E0E7FF',
          200: '#C7D2FE',
          300: '#A5B4FC',
          400: '#818CF8',
          500: '#6366F1',
          600: '#4F46E5',
          700: '#4338CA',
          800: '#3730A3',
          900: '#312E81',
        },
        accent: {
          DEFAULT: '#0D9488',
          light: '#5EEAD4',
        },
        // Mascot warm palette (from Figma onboarding)
        mascot: {
          DEFAULT: '#FFB800',
          50: '#FFF8E1',
          dark: '#F59E0B',
        },
        bg: {
          DEFAULT: '#FAFAFA',
          surface: '#FFFFFF',
          elev: '#F9FAFB',
        },
        text: {
          DEFAULT: '#111827',
          secondary: '#6B7280',
          muted: '#9CA3AF',
          inverse: '#FFFFFF',
        },
        border: {
          DEFAULT: '#E5E7EB',
          strong: '#D1D5DB',
        },
        success: { DEFAULT: '#059669', bg: '#D1FAE5' },
        warning: { DEFAULT: '#F59E0B', bg: '#FEF3C7' },
        danger: { DEFAULT: '#DC2626', bg: '#FEE2E2' },
        info: { DEFAULT: '#3B82F6', bg: '#DBEAFE' },
        status: {
          pending: '#F59E0B',
          accepted: '#3B82F6',
          'in-progress': '#4F46E5',
          completed: '#059669',
          cancelled: '#DC2626',
        },
      },
      fontFamily: {
        regular: ['PlusJakartaSans_400Regular'],
        medium: ['PlusJakartaSans_500Medium'],
        semibold: ['PlusJakartaSans_600SemiBold'],
        bold: ['PlusJakartaSans_700Bold'],
        extrabold: ['PlusJakartaSans_800ExtraBold'],
        display: ['Qurova_500Medium'],
      },
      fontSize: {
        xs: 11,
        sm: 13,
        base: 15,
        md: 16,
        lg: 18,
        xl: 20,
        '2xl': 24,
        '3xl': 28,
        '4xl': 32,
        '5xl': 40,
      },
      borderRadius: {
        sm: 6,
        md: 10,
        lg: 14,
        xl: 20,
        '2xl': 28,
        full: 9999,
      },
      // Spacing aligned to src/theme/index.ts Spacing scale.
      // Tailwind defaults are kept; we add the named tokens onboarding uses.
      spacing: {
        xs: 4,
        sm: 8,
        md: 12,
        base: 16,
        lg: 20,
        xl: 24,
        '2xl': 32,
        '3xl': 40,
        '4xl': 48,
        '5xl': 64,
      },
      boxShadow: {
        sm: '0 1px 4px rgba(0,0,0,0.06)',
        md: '0 2px 8px rgba(0,0,0,0.08)',
        lg: '0 4px 16px rgba(0,0,0,0.10)',
      },
    },
  },
  plugins: [],
};
