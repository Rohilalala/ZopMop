// TipScreen — slider 20-100 ₹ to leave the pro a tip. Charge happens at the
// end of the service; for now we just persist the chosen amount in-app via a
// callback. Dark themed to match BookingConfirmed / Chat.

import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  PanResponder,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';

import type { MainStackParamList } from '../../types/navigation';
import { showSuccess } from '../../utils/toast';
import { useC, type ScreenColors } from '../../theme/screen';
import { useTheme } from '../../context/ThemeContext';

const fontMed:   TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };
const fontBold:  TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

const MIN = 20;
const MAX = 100;
const STEP = 10;

const { width: SCREEN_W } = Dimensions.get('window');
const TRACK_PAD = 28;
const TRACK_WIDTH = SCREEN_W - TRACK_PAD * 2;
const THUMB_SIZE = 32;

export default function TipScreen() {
  const c = useC();
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(c, isDark), [c, isDark]);
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<RouteProp<MainStackParamList, 'Tip'>>();
  const insets = useSafeAreaInsets();

  const { helperName, initialAmountRupees } = route.params;
  const [amount, setAmount] = useState<number>(
    clampStep(initialAmountRupees ?? 40, MIN, MAX, STEP),
  );

  const dragStartRef = useRef(0);

  // Convert touch X (relative to track) to a snapped tip value.
  const xToAmount = (x: number): number => {
    const clamped = Math.max(0, Math.min(TRACK_WIDTH, x));
    const ratio = clamped / TRACK_WIDTH;
    const raw = MIN + ratio * (MAX - MIN);
    return clampStep(raw, MIN, MAX, STEP);
  };

  const trackPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          dragStartRef.current = evt.nativeEvent.locationX;
          setAmount(xToAmount(dragStartRef.current));
        },
        onPanResponderMove: (_evt, g) => {
          const x = dragStartRef.current + g.dx;
          setAmount(xToAmount(x));
        },
      }),
    [],
  );

  const ratio = (amount - MIN) / (MAX - MIN);
  const thumbX = ratio * TRACK_WIDTH;

  const onConfirm = () => {
    showSuccess(
      `₹${amount} will be added to ${helperName ?? 'your pro'}'s payout when the service ends.`,
      { title: 'Tip added' },
    );
    navigation.goBack();
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
        >
          <Feather name="chevron-left" size={20} color={c.text} />
        </Pressable>
        <Text style={[fontExtra, styles.headerTitle]}>Add a tip</Text>
        <View style={{ width: 38 }} />
      </View>

      <View style={styles.body}>
        <View style={styles.heroBadge}>
          <Feather name="award" size={26} color={c.amber} />
        </View>
        <Text style={[fontExtra, styles.title]}>
          Loving the service?
        </Text>
        <Text style={[fontMed, styles.subtitle]}>
          100% of your tip goes to {helperName ?? 'your pro'}.
          You'll be charged when the service wraps up.
        </Text>

        {/* Amount display */}
        <View style={styles.amountWrap}>
          <Text style={[fontExtra, styles.currency]}>₹</Text>
          <Text style={[fontExtra, styles.amount]}>{amount}</Text>
        </View>

        {/* Slider */}
        <View style={styles.sliderWrap}>
          {/* Track expands the touch area vertically so the thumb is easy to grab. */}
          <View style={styles.trackTouch} {...trackPan.panHandlers}>
            <View style={styles.track}>
              <View style={[styles.fill, { width: thumbX }]} />
              <View
                pointerEvents="none"
                style={[styles.thumb, { left: thumbX - THUMB_SIZE / 2 }]}
              >
                <View style={styles.thumbInner} />
              </View>
            </View>
          </View>
          <View style={styles.scaleRow}>
            <Text style={[fontMed, styles.scaleText]}>₹{MIN}</Text>
            <Text style={[fontMed, styles.scaleText]}>₹{MAX}</Text>
          </View>
        </View>

        {/* Preset chips */}
        <View style={styles.presets}>
          {[20, 40, 60, 80, 100].map((p) => {
            const active = amount === p;
            return (
              <Pressable
                key={p}
                onPress={() => setAmount(p)}
                style={({ pressed }) => [
                  styles.preset,
                  active && styles.presetActive,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={[fontBold, active ? styles.presetTextActive : styles.presetText]}>
                  ₹{p}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Confirm dock */}
      <View style={[styles.dock, { paddingBottom: insets.bottom + 16 }]}>
        <Pressable
          onPress={onConfirm}
          style={({ pressed }) => [styles.confirm, pressed && { opacity: 0.85 }]}
        >
          <Text style={[fontExtra, styles.confirmText]}>Add ₹{amount} tip</Text>
          {/* Ink on amber — same in both themes. */}
          <Feather name="chevron-right" size={16} color="#0D0D0F" />
        </Pressable>
      </View>
    </View>
  );
}

function clampStep(v: number, min: number, max: number, step: number): number {
  const c = Math.max(min, Math.min(max, v));
  return Math.round(c / step) * step;
}

// THEME NOTE: migrated to useC() (screen.ts), NOT useColors() (theme/colors
// slate). Dark stays #0A0A0A bg + #F5A300 amber, pixel-identical to before;
// light adds the cream bg + amber. Ink that sits on amber surfaces (#0D0D0F)
// stays literal in both themes since amber is the same in both.
function makeStyles(c: ScreenColors, isDark: boolean) {
  // Slider thumb is a raised white knob in dark; no useC equivalent → keep the
  // exact literal in dark and use the white surface token in light.
  const thumbBg = isDark ? '#FFFFFF' : c.white;
  // Dock backdrop is the bg tinted to 0.96 in dark → keep that literal exactly;
  // in light fall back to the (opaque) cream bg.
  const dockBg = isDark ? 'rgba(10,10,10,0.96)' : c.bg;
  // Slider track base sits between the glass tokens (0.10) → keep the exact
  // dark literal; in light use the subtle ink hairline so the track is visible.
  const trackBg = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(13,13,15,0.10)';

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingBottom: 14,
    },
    headerTitle: {
      flex: 1,
      color: c.text,
      fontSize: 16,
      textAlign: 'center',
      letterSpacing: -0.3,
    },
    iconBtn: {
      width: 38, height: 38, borderRadius: 19,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.glassHi,
    },

    body: {
      flex: 1,
      alignItems: 'center',
      paddingHorizontal: 24,
      paddingTop: 12,
    },

    heroBadge: {
      width: 64, height: 64, borderRadius: 32,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(245,163,0,0.16)',
      borderWidth: 1,
      borderColor: c.amberLine,
      marginBottom: 18,
    },
    title: {
      color: c.text,
      fontSize: 22,
      letterSpacing: -0.5,
      textAlign: 'center',
    },
    subtitle: {
      color: c.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
      marginTop: 8,
      maxWidth: 320,
    },

    amountWrap: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      marginTop: 36,
      marginBottom: 12,
    },
    currency: {
      color: c.amber,
      fontSize: 28,
      paddingBottom: 6,
      marginRight: 4,
    },
    amount: {
      color: c.text,
      fontSize: 64,
      letterSpacing: -2,
      lineHeight: 64,
    },

    sliderWrap: {
      width: '100%',
      paddingHorizontal: TRACK_PAD - 24,
      marginTop: 24,
      marginBottom: 24,
    },
    trackTouch: {
      width: TRACK_WIDTH,
      alignSelf: 'center',
      paddingVertical: 16,
    },
    track: {
      width: TRACK_WIDTH,
      height: 6,
      borderRadius: 3,
      backgroundColor: trackBg,
      position: 'relative',
    },
    fill: {
      position: 'absolute',
      left: 0, top: 0, bottom: 0,
      backgroundColor: c.amber,
      borderRadius: 3,
    },
    thumb: {
      position: 'absolute',
      top: -(THUMB_SIZE - 6) / 2,
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      borderRadius: THUMB_SIZE / 2,
      backgroundColor: thumbBg,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: c.amber,
      shadowOpacity: 0.4,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    thumbInner: {
      width: 10, height: 10, borderRadius: 5,
      backgroundColor: c.amber,
    },
    scaleRow: {
      width: TRACK_WIDTH,
      alignSelf: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 14,
    },
    scaleText: {
      color: c.textMuted,
      fontSize: 11,
    },

    presets: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 16,
      flexWrap: 'wrap',
      justifyContent: 'center',
    },
    preset: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 99,
      backgroundColor: c.glassHi,
      borderWidth: 0.5,
      borderColor: c.glassBorder,
    },
    presetActive: {
      backgroundColor: 'rgba(245,163,0,0.18)',
      borderColor: c.amber,
    },
    presetText:       { color: c.textSecondary, fontSize: 13 },
    presetTextActive: { color: c.amber, fontSize: 13 },

    dock: {
      paddingHorizontal: 20,
      paddingTop: 14,
      borderTopWidth: 0.5,
      borderTopColor: c.divider,
      backgroundColor: dockBg,
    },
    confirm: {
      height: 54,
      borderRadius: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: c.amber,
      shadowColor: c.amber,
      shadowOpacity: 0.4,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: 14 },
      elevation: 8,
    },
    // Ink on amber — same in both themes.
    confirmText: {
      color: '#0D0D0F',
      fontSize: 14,
      letterSpacing: -0.2,
    },
  });
}
