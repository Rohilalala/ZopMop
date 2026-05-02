import type { Config } from 'tailwindcss';

// Design tokens are the source of truth — referenced in src/styles/index.css
// as CSS variables and inlined here so Tailwind utility classes (bg-bg,
// border-border, etc.) Just Work in JSX without leaning on arbitrary values.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0A0A0F',
        surface: '#111118',
        'surface-elevated': '#1A1A24',
        border: '#2A2A3A',
        primary: {
          DEFAULT: '#6C63FF',
          glow: 'rgba(108, 99, 255, 0.15)',
        },
        accent: {
          DEFAULT: '#00D4AA',
          glow: 'rgba(0, 212, 170, 0.12)',
        },
        danger: '#FF4D6A',
        warning: '#FFB547',
        success: '#00D4AA',
        text: {
          primary: '#F0F0FF',
          secondary: '#8888AA',
          muted: '#4A4A6A',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        '2xl': '1rem',
      },
      boxShadow: {
        'glow-primary': '0 0 0 1px rgba(108, 99, 255, 0.4), 0 8px 32px -8px rgba(108, 99, 255, 0.35)',
        'glow-accent':  '0 0 0 1px rgba(0, 212, 170, 0.4), 0 8px 32px -8px rgba(0, 212, 170, 0.30)',
        'glow-danger':  '0 0 0 1px rgba(255, 77, 106, 0.4), 0 8px 32px -8px rgba(255, 77, 106, 0.30)',
      },
      transitionDuration: {
        DEFAULT: '150ms',
      },
      keyframes: {
        'shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-6px)' },
          '75%': { transform: 'translateX(6px)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
      },
      animation: {
        'shake': 'shake 0.4s ease-in-out',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
