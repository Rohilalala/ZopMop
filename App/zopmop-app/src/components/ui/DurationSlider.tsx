// DurationSlider — sliding segmented control for the service duration picker
// (iOS only; Android keeps the static chips). Same recipe as the catalog's
// Schedule|Instant mode toggle: glass capsule container with an amber glider
// pill that springs under the selected segment. The glider is also draggable
// (like the native UISegmentedControl) and snaps to the nearest segment on
// release, with selection haptic ticks as it crosses segments.
//
// Generic over the options list (30/60/90 for most services, but any detent
// set from buildDurations works). Fixed-duration services never reach this —
// the caller renders the fixed chip instead.

import React, { useCallback, useEffect, useState } from 'react';
import { Text, View, type TextStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { PressFx } from './PressFx';
import { useC } from '../../theme/screen';
import { haptics } from '../../utils/haptics';

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };

const PAD = 4; // container inner padding — glider insets, matches modeWrap
// Tuned to feel like the mode toggle's glide — quick, light overshoot.
const SPRING = { damping: 18, stiffness: 260, mass: 0.6 };

type Props = {
  options: number[];
  value: number;
  onChange: (d: number) => void;
};

export function DurationSlider({ options, value, onChange }: Props) {
  const c = useC();
  const n = options.length;
  const [w, setW] = useState(0);
  const segW = n > 0 ? Math.max((w - PAD * 2) / n, 0) : 0;

  const pos = useSharedValue(0); // glider LEFT edge offset from PAD, 0..segW*(n-1)
  const startPos = useSharedValue(0);
  const idx = useSharedValue(Math.max(0, options.indexOf(value))); // last ticked segment

  const commit = useCallback(
    (i: number) => {
      const d = options[i];
      if (d !== value) onChange(d);
    },
    [options, value, onChange],
  );
  const tick = useCallback(() => haptics.selection(), []);

  // Sync glider to the external value (and on first layout). No dragging
  // guard: value can only change on tap or drag-release (commit never fires
  // mid-drag), so this never fights the finger. A guard here actually BROKE
  // taps — the pan's onBegin fires on touch-down even for plain taps, so the
  // "dragging" flag was still set when the tap's onChange landed.
  useEffect(() => {
    if (segW === 0) return;
    const i = Math.max(0, options.indexOf(value));
    idx.value = i;
    pos.value = withSpring(segW * i, SPRING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, segW, options.join(',')]);

  const maxPos = segW * (n - 1);

  const pan = Gesture.Pan()
    // Inside the sheet's vertical ScrollView: claim clearly-horizontal drags,
    // fail fast on vertical ones so list scrolling still works over the control.
    .activeOffsetX([-6, 6])
    .failOffsetY([-12, 12])
    .onBegin(() => {
      'worklet';
      startPos.value = pos.value;
    })
    .onUpdate((e) => {
      'worklet';
      if (segW <= 0 || n <= 1) return;
      const p = Math.min(maxPos, Math.max(0, startPos.value + e.translationX));
      pos.value = p;
      // Haptic tick when the glider crosses into a new segment's half.
      const i = Math.round(p / segW);
      if (i !== idx.value) {
        idx.value = i;
        runOnJS(tick)();
      }
    })
    .onEnd(() => {
      'worklet';
      if (segW <= 0 || n <= 1) return;
      const i = Math.round(pos.value / segW);
      pos.value = withSpring(segW * i, SPRING);
      runOnJS(commit)(i);
    });

  const gliderStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: PAD + pos.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <View
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        style={{
          flexDirection: 'row',
          backgroundColor: c.glass,
          borderWidth: 0.5,
          borderColor: c.glassBorder,
          borderRadius: 14,
          padding: PAD,
          position: 'relative',
        }}
      >
        {/* amber glider — same treatment as the Schedule|Instant toggle */}
        <Animated.View
          pointerEvents="none"
          style={[
            gliderStyle,
            {
              position: 'absolute',
              top: PAD,
              left: 0,
              bottom: PAD,
              width: segW,
              borderRadius: 10,
              backgroundColor: c.amber,
              shadowColor: '#F5A300',
              shadowOpacity: 0.3,
              shadowOffset: { width: 0, height: 4 },
              shadowRadius: 10,
              elevation: 4,
            },
          ]}
        />
        {options.map((d) => {
          const sel = d === value;
          return (
            <PressFx
              key={d}
              onPress={() => {
                haptics.selection();
                onChange(d);
              }}
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                paddingVertical: 12,
                borderRadius: 10,
                zIndex: 1,
              }}
            >
              <Text
                style={[
                  fontBold,
                  {
                    fontSize: 14,
                    letterSpacing: -0.2,
                    // active label sits on the amber glider → ink in both themes
                    color: sel ? '#0D0D0F' : c.textSecondary,
                  },
                ]}
              >
                {d} min
              </Text>
            </PressFx>
          );
        })}
      </View>
    </GestureDetector>
  );
}
