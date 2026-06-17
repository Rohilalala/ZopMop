// ModeToggle — reusable Schedule | Instant segmented control with a sliding
// amber glider. Extracted verbatim from AllServicesScreen so the cart (and any
// other host) can render the same timing selector.

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';

import { useTheme } from '../context/ThemeContext';
import { useC, type ScreenColors } from '../theme/screen';
import { PressFx } from './ui/PressFx';

export type Mode = 'schedule' | 'instant';

export function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (next: Mode) => void;
}) {
  const c = useC();
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const [w, setW] = useState(0);
  const offset = useSharedValue(mode === 'schedule' ? 0 : 1);

  useEffect(() => {
    // Snappy spring — matches BookingsScreen tab glider exactly.
    offset.value = withSpring(mode === 'schedule' ? 0 : 1, {
      damping: 26,
      stiffness: 320,
      mass: 0.7,
      overshootClamping: false,
    });
  }, [mode]);

  const gliderWidth = Math.max((w - 8) / 2, 0);
  const gliderStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: 4 + offset.value * gliderWidth }],
  }));

  return (
    <View style={styles.modeWrap} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Animated.View
        style={[
          styles.modeGlider,
          { width: gliderWidth },
          gliderStyle,
        ]}
      />
      <ModeBtn
        active={mode === 'schedule'}
        onPress={() => onChange('schedule')}
        icon="calendar"
        label="Schedule"
      />
      <ModeBtn
        active={mode === 'instant'}
        onPress={() => onChange('instant')}
        icon="zap"
        label="Instant"
      />
    </View>
  );
}

function ModeBtn({
  active,
  onPress,
  icon,
  label,
}: {
  active: boolean;
  onPress: () => void;
  icon: 'calendar' | 'zap';
  label: string;
}) {
  const c = useC();
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  return (
    <PressFx onPress={onPress} style={styles.modeBtn}>
      <Feather
        name={icon}
        size={14}
        // active icon sits on the amber glider → ink in both themes
        color={active ? '#0D0D0F' : c.textSecondary}
      />
      <Text style={[styles.modeLabel, active && styles.modeLabelActive]}>{label}</Text>
    </PressFx>
  );
}

function makeStyles(c: ScreenColors, _isDark: boolean) {
  return StyleSheet.create({
    // Mode toggle (Schedule | Instant) — segmented control with sliding glider.
    modeWrap: {
      flexDirection: 'row',
      backgroundColor: c.glass,
      borderWidth: 0.5,
      borderColor: c.glassBorder,
      borderRadius: 12,
      padding: 4,
      position: 'relative',
    },
    modeGlider: {
      position: 'absolute',
      top: 4,
      left: 0,
      bottom: 4,
      borderRadius: 9,
      backgroundColor: c.amber,
      shadowColor: '#F5A300',
      shadowOpacity: 0.3,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 10,
      elevation: 4,
    },
    modeBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 9,
      borderRadius: 9,
      zIndex: 1,
    },
    modeLabel: {
      fontFamily: 'PlusJakartaSans_700Bold',
      fontSize: 13,
      color: c.textSecondary,
      letterSpacing: -0.13,
    },
    // active label sits on the amber glider → ink in both themes
    modeLabelActive: { color: '#0D0D0F' },
  });
}
