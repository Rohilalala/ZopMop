import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import { lightColors, darkColors } from '../theme/colors';

type ColorScheme = typeof lightColors;

interface ThemeContextValue {
  isDark: boolean;
  colors: ColorScheme;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'zopmop_dark_mode';

const ThemeContext = createContext<ThemeContextValue>({
  isDark: true,
  colors: darkColors as unknown as ColorScheme,
  toggleTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    SecureStore.getItemAsync(STORAGE_KEY).then(val => {
      if (val === 'false') setIsDark(false);
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      SecureStore.setItemAsync(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ isDark, colors: (isDark ? darkColors : lightColors) as ColorScheme, toggleTheme }}>
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
