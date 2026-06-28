import React, { useEffect, useRef } from 'react';
import {
  Platform,
  Switch,
  View,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
} from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import { useC } from '../../theme/screen';

type Props = {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
};

// App-wide toggle. iOS renders the native Switch (Apple look + liquid-glass on
// iOS 26); Android renders a custom animated track/thumb so it doesn't fall back
// to the Material toggle. Use this for every on/off switch in the app.
export function AppSwitch({ value, onValueChange, disabled }: Props) {
  const c = useC();
  const { isDark } = useTheme();

  if (Platform.OS === 'ios') {
    return (
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{
          false: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(120,120,128,0.30)',
          true: c.amber,
        }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={isDark ? 'rgba(255,255,255,0.12)' : 'rgba(120,120,128,0.16)'}
      />
    );
  }

  return <AndroidToggle value={value} onValueChange={onValueChange} disabled={disabled} isDark={isDark} />;
}

// Android custom toggle (the previous ProfileScreen toggle, made reusable).
function AndroidToggle({
  value,
  onValueChange,
  disabled,
  isDark,
}: Props & { isDark: boolean }) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0,
      duration: 220,
      easing: Easing.bezier(0.37, 1.95, 0.66, 0.56),
      useNativeDriver: false,
    }).start();
  }, [value]);

  const left = anim.interpolate({ inputRange: [0, 1], outputRange: [2, 20] });

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={s.hit}
    >
      <View
        style={[
          s.track,
          value ? null : { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(13,13,15,0.08)' },
        ]}
      >
        {value && (
          <View style={StyleSheet.absoluteFill}>
            <Svg width="46" height="28">
              <Defs>
                <SvgLinearGradient id="appSwitchGrad" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%" stopColor="#FFC042" />
                  <Stop offset="100%" stopColor="#F5A300" />
                </SvgLinearGradient>
              </Defs>
              <Rect width="46" height="28" rx="14" fill="url(#appSwitchGrad)" />
            </Svg>
          </View>
        )}
        <Animated.View style={[s.thumb, { left }]} />
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  hit: { padding: 2 },
  track: {
    width: 46,
    height: 28,
    borderRadius: 14,
    overflow: 'hidden',
    position: 'relative',
  },
  thumb: {
    position: 'absolute',
    top: 2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    zIndex: 1,
  },
});
