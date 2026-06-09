import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useSharedValue, withTiming, Easing, type SharedValue } from 'react-native-reanimated';
import { lightColors, darkColors } from '../theme/colors';

type ColorScheme = typeof lightColors;

// Shared timing so the AppSwitch and the screen-wide colour morph land together.
export const THEME_ANIM = { duration: 340, easing: Easing.inOut(Easing.cubic) };

interface ThemeContextValue {
  isDark: boolean;
  colors: ColorScheme;
  toggleTheme: () => void;
  // Animated theme position: 0 = dark, 1 = light. Drives the seamless colour
  // transition (interpolateColor) on screens that morph in place (Profile).
  progress: SharedValue<number>;
}

const STORAGE_KEY = 'zopmop_dark_mode';

const ThemeContext = createContext<ThemeContextValue>({
  isDark: true,
  colors: darkColors as unknown as ColorScheme,
  toggleTheme: () => {},
  progress: { value: 0 } as SharedValue<number>,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true);
  // 0 = dark, 1 = light. Kept in lock-step with isDark; animates on toggle.
  const progress = useSharedValue(0);

  useEffect(() => {
    SecureStore.getItemAsync(STORAGE_KEY).then(val => {
      if (val === 'false') {
        setIsDark(false);
        progress.value = 1; // restore light instantly, no animation on launch
      }
    });
  }, []);

  const toggleTheme = useCallback(() => {
    const next = !isDark; // next isDark
    setIsDark(next);
    progress.value = withTiming(next ? 0 : 1, THEME_ANIM);
    SecureStore.setItemAsync(STORAGE_KEY, String(next));
  }, [isDark]);

  return (
    <ThemeContext.Provider
      value={{
        isDark,
        colors: (isDark ? darkColors : lightColors) as ColorScheme,
        toggleTheme,
        progress,
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
