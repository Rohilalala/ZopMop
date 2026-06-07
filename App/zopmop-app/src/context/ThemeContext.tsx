import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import * as SecureStore from 'expo-secure-store';
import { lightColors, darkColors } from '../theme/colors';

type ColorScheme = typeof lightColors;

export type ThemeTransition = {
  origin: { x: number; y: number };
  targetIsDark: boolean;
} | null;

interface ThemeContextValue {
  isDark: boolean;
  colors: ColorScheme;
  toggleTheme: (origin?: { x: number; y: number }) => void;
  transition: ThemeTransition;
  clearTransition: () => void;
}

const STORAGE_KEY = 'zopmop_dark_mode';
const REVEAL_DELAY_MS = 650;

const ThemeContext = createContext<ThemeContextValue>({
  isDark: true,
  colors: darkColors as unknown as ColorScheme,
  toggleTheme: () => {},
  transition: null,
  clearTransition: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true);
  const [transition, setTransition] = useState<ThemeTransition>(null);
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync(STORAGE_KEY).then(val => {
      if (val === 'false') setIsDark(false);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (flipTimer.current) clearTimeout(flipTimer.current);
    };
  }, []);

  const toggleTheme = useCallback((origin?: { x: number; y: number }) => {
    const next = !isDark;
    if (origin) {
      setTransition({ origin, targetIsDark: next });
    }
    setIsDark(next);
    SecureStore.setItemAsync(STORAGE_KEY, String(next));
  }, [isDark]);

  const clearTransition = useCallback(() => {
    setTransition(null);
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        isDark,
        colors: (isDark ? darkColors : lightColors) as ColorScheme,
        toggleTheme,
        transition,
        clearTransition,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useColors() {
  return useContext(ThemeContext).colors;
}
