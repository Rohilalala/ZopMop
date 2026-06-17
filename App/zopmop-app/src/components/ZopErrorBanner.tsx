// ZopErrorBanner — the friendly error surface. A glass-overlay card drops in
// from the top; Zop flies in from the left and rides back up with the card on
// dismiss. Used for ERRORS only, and only on screens where Zop isn't already
// on stage (the route gate lives in utils/toast.ts). Driven imperatively via
// presentZopError(); the host <ZopErrorHost/> is mounted once at the app root.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, Pressable, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { haptics } from '../utils/haptics';
import ZopConfused from '../../assets/zop/zop-confused.svg';

export type ZopErrorPayload = { title?: string; message: string };

// Imperative bridge: toast.ts calls presentZopError(); the mounted host
// registers the setter. Single active banner — a new error replaces the old.
let present: ((p: ZopErrorPayload) => void) | null = null;
export function presentZopError(p: ZopErrorPayload) {
  present?.(p);
}

const AUTO_DISMISS_MS = 4200;
const OFF_TOP = -280; // card parked above the screen
const OFF_LEFT = -340; // Zop parked off the left edge

export function ZopErrorHost() {
  const insets = useSafeAreaInsets();
  const [content, setContent] = useState<ZopErrorPayload | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cardY = useSharedValue(OFF_TOP);
  const cardOpacity = useSharedValue(0);
  const zopX = useSharedValue(OFF_LEFT);
  const zopOpacity = useSharedValue(0);

  const clearContent = useCallback(() => setContent(null), []);

  const hide = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // Card lifts straight up; Zop is a child of the card, so it rides up too.
    cardOpacity.value = withTiming(0, { duration: 260 });
    cardY.value = withTiming(
      OFF_TOP,
      { duration: 320, easing: Easing.in(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(clearContent)();
      },
    );
  }, [cardOpacity, cardY, clearContent]);

  // Register the imperative entry point once.
  useEffect(() => {
    present = (p) => setContent(p);
    return () => {
      present = null;
    };
  }, []);

  // Animate in whenever new content arrives (replacing any current banner).
  useEffect(() => {
    if (!content) return;
    haptics.error();
    cardY.value = OFF_TOP;
    cardOpacity.value = 0;
    zopX.value = OFF_LEFT;
    zopOpacity.value = 0;
    // Card drops from the top with a soft spring.
    cardOpacity.value = withTiming(1, { duration: 160 });
    cardY.value = withSpring(0, { damping: 18, stiffness: 220, mass: 0.9 });
    // Zop flies in from the left once the card has (mostly) landed.
    zopOpacity.value = withDelay(260, withTiming(1, { duration: 140 }));
    zopX.value = withDelay(260, withSpring(0, { damping: 15, stiffness: 240, mass: 0.8 }));

    timer.current = setTimeout(hide, AUTO_DISMISS_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [content, cardY, cardOpacity, zopX, zopOpacity, hide]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: cardY.value }],
    opacity: cardOpacity.value,
  }));
  const zopStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: zopX.value }],
    opacity: zopOpacity.value,
  }));

  if (!content) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 6 }]}>
      <Animated.View style={[styles.card, cardStyle]}>
        <BlurView intensity={26} tint="dark" style={StyleSheet.absoluteFill} />
        <View pointerEvents="none" style={styles.tint} />
        <View pointerEvents="none" style={styles.hairline} />
        <Pressable style={styles.row} onPress={hide} accessibilityRole="alert">
          <Animated.View pointerEvents="none" style={[styles.zop, zopStyle]}>
            <ZopConfused width={94} height={94} />
          </Animated.View>
          <View style={styles.txt}>
            {!!content.title && <Text style={styles.title}>{content.title}</Text>}
            <Text style={styles.body}>{content.message}</Text>
          </View>
          <Text style={styles.x}>✕</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const RADIUS = 24;
const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, zIndex: 9999, elevation: 9999 },
  card: {
    borderRadius: RADIUS,
    minHeight: 102,
    overflow: 'hidden',
    backgroundColor: 'rgba(10,10,10,0.45)',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 14 },
  },
  // Dark tint over the blur — matches the ZopMop glass.overlay token.
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,10,0.55)', borderRadius: RADIUS, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.10)' },
  hairline: { position: 'absolute', top: 0, left: 112, right: 18, height: 2, borderRadius: 2, backgroundColor: '#F5A300', opacity: 0.55 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingRight: 14, paddingLeft: 118, minHeight: 102 },
  zop: { position: 'absolute', left: 14, top: 0, bottom: 0, width: 94, justifyContent: 'center' },
  txt: { flex: 1, minWidth: 0 },
  title: { fontFamily: 'PlusJakartaSans_700Bold', fontSize: 14.5, color: '#FFFFFF', letterSpacing: -0.1 },
  body: { fontFamily: 'PlusJakartaSans_500Medium', fontSize: 12.5, lineHeight: 17, color: '#E3E3E3', marginTop: 3 },
  x: { color: 'rgba(255,255,255,0.45)', fontSize: 15, paddingHorizontal: 4, alignSelf: 'flex-start' },
});
