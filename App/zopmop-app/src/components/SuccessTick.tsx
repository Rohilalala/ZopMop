// Shared success tick — extracted verbatim from BookingConfirmedScreen's
// CheckOrb + Confetti so the two screens stay in sync. The default colors below
// reproduce BookingConfirmed's ORIGINAL hardcoded look exactly (behavior-
// preserving); ServiceComplete passes light/dark overrides + a halo.
//
// Specs: orb 108 / solid ring 132 / dashed ring 152, spring-pop
// cubic-bezier(.2,1.3,.4,1) via withSpring(damping 14, stiffness 200) + 1.08
// overshoot, 18s dashed spin. Honors prefers-reduced-motion.
import React, { useEffect } from 'react';
import { View, Dimensions, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path, Defs, LinearGradient as SvgLinearGradient, RadialGradient, Stop } from 'react-native-svg';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const ORB = 108;
const SOLID = 132;
const DASHED = 152;

export type TickColors = {
  orbTop: string;
  orbBottom: string;
  dash: string;
  solid: string;
  pulse: string;
  shadow: string;
  tick: string;
  tickShadow: string;
};

// Defaults === BookingConfirmed's original hardcoded values. Do not "improve"
// these to tokens — that would shift the shipped screen's green.
const DEFAULT_COLORS: TickColors = {
  orbTop: '#5BE08A',
  orbBottom: '#16A34A',
  dash: 'rgba(34,197,94,0.32)',
  solid: 'rgba(34,197,94,0.45)',
  pulse: 'rgba(34,197,94,0.35)',
  shadow: '#22C55E',
  tick: '#FFFFFF',
  tickShadow: 'rgba(0,0,0,0.22)',
};

export type HaloStop = { offset: number; color: string };

export function SuccessTick({
  colors,
  halo,
  style,
  sizeScale = 1,
}: {
  colors?: Partial<TickColors>;
  /** Radial-gradient stops rendered behind the orb. Omit for none (BookingConfirmed). */
  halo?: HaloStop[];
  style?: ViewStyle;
  /** Uniform scale of the whole tick (1 = BookingConfirmed's 108/132/152). */
  sizeScale?: number;
}) {
  const c = { ...DEFAULT_COLORS, ...colors };
  const reduced = useReducedMotion();

  // Spring-pop: 0.4 → 1.08 → 1
  const scale = useSharedValue(reduced ? 1 : 0.4);
  const opacity = useSharedValue(reduced ? 1 : 0);
  // Pulse ring: 0.6 → 1.5, opacity 0→1→0
  const ringScale = useSharedValue(0.6);
  const ringOpacity = useSharedValue(0);
  // Outer dashed ring: continuous slow spin
  const spin = useSharedValue(0);

  useEffect(() => {
    if (reduced) return; // static frame reads correctly (orb base fully visible)
    scale.value = withDelay(
      150,
      withSequence(
        withTiming(1.08, { duration: 420, easing: Easing.out(Easing.cubic) }),
        withSpring(1, { damping: 14, stiffness: 200 }),
      ),
    );
    opacity.value = withDelay(150, withTiming(1, { duration: 220 }));
    ringScale.value = withDelay(400, withTiming(1.5, { duration: 1400, easing: Easing.out(Easing.cubic) }));
    ringOpacity.value = withDelay(
      400,
      withSequence(withTiming(1, { duration: 280 }), withTiming(0, { duration: 1120 })),
    );
    spin.value = withRepeat(withTiming(360, { duration: 18000, easing: Easing.linear }), -1, false);
  }, [reduced]);

  const orbStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }], opacity: opacity.value }));
  const ringStyle = useAnimatedStyle(() => ({ transform: [{ scale: ringScale.value }], opacity: ringOpacity.value }));
  const dashedStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value}deg` }] }));

  // Scale by resizing the geometry (SVG/borders redraw crisp) rather than a
  // transform on the rasterized layer — transform scaling blurs the tick.
  const k = sizeScale;
  const orb = ORB * k;
  const solid = SOLID * k;
  const dashed = DASHED * k;
  const HALO = dashed + 32 * k; // design: inset -16 around the wrap
  const tickSize = 54 * k;

  const STROKE = 1.5 * k;
  const dr = (dashed - STROKE) / 2;
  const circ = 2 * Math.PI * dr;
  const DASH = circ / 50 / 2;

  return (
    <View style={[{ width: dashed, height: dashed, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' }, style]}>
      {/* Halo — radial glow behind the orb (lifts it off the bg; cream-core in light) */}
      {halo && halo.length > 0 && (
        <Svg width={HALO} height={HALO} style={{ position: 'absolute' }}>
          <Defs>
            <RadialGradient id="tickHalo" cx="50%" cy="50%" r="50%">
              {halo.map((s, i) => (
                <Stop key={i} offset={s.offset} stopColor={s.color} />
              ))}
            </RadialGradient>
          </Defs>
          <Circle cx={HALO / 2} cy={HALO / 2} r={HALO / 2} fill="url(#tickHalo)" />
        </Svg>
      )}

      {/* Outer dashed ring — SVG so dashes tile evenly (no seam). */}
      <Animated.View style={[dashedStyle, { position: 'absolute', width: dashed, height: dashed }]}>
        <Svg width={dashed} height={dashed}>
          <Circle
            cx={dashed / 2}
            cy={dashed / 2}
            r={dr}
            stroke={c.dash}
            strokeWidth={STROKE}
            strokeDasharray={[DASH, DASH]}
            strokeLinecap="butt"
            fill="none"
          />
        </Svg>
      </Animated.View>

      {/* Static solid ring */}
      <View
        style={{
          position: 'absolute',
          width: solid,
          height: solid,
          borderRadius: solid / 2,
          borderWidth: 1.5 * k,
          borderColor: c.solid,
        }}
      />

      {/* Pulse ring — expand + fade outward */}
      <Animated.View
        style={[
          ringStyle,
          {
            position: 'absolute',
            width: solid,
            height: solid,
            borderRadius: solid / 2,
            borderWidth: 2 * k,
            borderColor: c.pulse,
          },
        ]}
      />

      {/* Orb */}
      <Animated.View
        style={[
          orbStyle,
          {
            width: orb,
            height: orb,
            borderRadius: orb / 2,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: c.shadow,
            shadowOffset: { width: 0, height: 20 * k },
            shadowOpacity: 0.45,
            shadowRadius: 50 * k,
            elevation: 14,
            overflow: 'hidden',
            borderWidth: 2 * k,
            borderTopColor: 'rgba(255,255,255,0.45)',
            borderBottomColor: 'rgba(0,0,0,0.18)',
            borderLeftColor: 'rgba(255,255,255,0.18)',
            borderRightColor: 'rgba(255,255,255,0.18)',
          },
        ]}
      >
        <Svg width={orb} height={orb} style={{ position: 'absolute', top: 0, left: 0 }}>
          <Defs>
            <SvgLinearGradient id="orbGrad" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={c.orbTop} />
              <Stop offset="1" stopColor={c.orbBottom} />
            </SvgLinearGradient>
          </Defs>
          <Circle cx={orb / 2} cy={orb / 2} r={orb / 2} fill="url(#orbGrad)" />
        </Svg>

        {/* Tick — white stroke over an offset shadow stroke for 3D feel. */}
        <Svg width={tickSize} height={tickSize} viewBox="0 0 24 24" fill="none">
          <Path d="M5 12.5l5 5 9-11" stroke={c.tickShadow} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" transform="translate(0,1.4)" />
          <Path d="M5 12.5l5 5 9-11" stroke={c.tick} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </Animated.View>
    </View>
  );
}

// ── Confetti — 9 colored dots (extracted verbatim from BookingConfirmed) ──────
const CONFETTI: { x: number; y: number; w: number; h: number; bg: string; rot: number; round: boolean; delay: number }[] = [
  { x: 0.18, y: 0.14, w: 8, h: 8, bg: '#F5A300', rot: 0, round: false, delay: 200 },
  { x: 0.30, y: 0.08, w: 6, h: 6, bg: '#22C55E', rot: 0, round: true, delay: 400 },
  { x: 0.62, y: 0.11, w: 7, h: 14, bg: '#60A5FA', rot: 20, round: false, delay: 500 },
  { x: 0.78, y: 0.18, w: 8, h: 8, bg: '#FFC042', rot: 0, round: true, delay: 300 },
  { x: 0.48, y: 0.06, w: 6, h: 12, bg: '#F5A300', rot: -25, round: false, delay: 550 },
  { x: 0.84, y: 0.32, w: 6, h: 6, bg: '#22C55E', rot: 0, round: true, delay: 700 },
  { x: 0.10, y: 0.34, w: 5, h: 5, bg: '#FFC042', rot: 0, round: true, delay: 600 },
  { x: 0.90, y: 0.09, w: 6, h: 10, bg: '#F87171', rot: 15, round: false, delay: 450 },
  { x: 0.24, y: 0.30, w: 5, h: 9, bg: '#22C55E', rot: -15, round: false, delay: 800 },
];

// boxW/boxH default to the full screen → BookingConfirmed renders unchanged
// (dots at SCREEN_W*x / SCREEN_H*y). Pass a smaller box to burst the same dots
// around a centered tick (ServiceComplete), keeping colors/animation identical.
export function Confetti({ boxW = SCREEN_W, boxH = SCREEN_H }: { boxW?: number; boxH?: number } = {}) {
  const reduced = useReducedMotion();
  if (reduced) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: boxW, height: boxH, zIndex: 3 }}>
      {CONFETTI.map((c, i) => (
        <ConfettiDot key={i} cfg={c} boxW={boxW} boxH={boxH} />
      ))}
    </View>
  );
}

function ConfettiDot({ cfg, boxW, boxH }: { cfg: typeof CONFETTI[number]; boxW: number; boxH: number }) {
  const fall = useSharedValue(0);
  useEffect(() => {
    fall.value = withDelay(cfg.delay, withTiming(1, { duration: 2400, easing: Easing.in(Easing.cubic) }));
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: fall.value < 0.05 ? 0 : fall.value < 0.2 ? fall.value / 0.2 : 1 - fall.value,
    transform: [{ translateY: -30 + fall.value * 250 }, { rotate: `${cfg.rot + fall.value * 140}deg` }],
  }));
  return (
    <Animated.View
      style={[
        style,
        {
          position: 'absolute',
          left: boxW * cfg.x,
          top: boxH * cfg.y,
          width: cfg.w,
          height: cfg.h,
          backgroundColor: cfg.bg,
          borderRadius: cfg.round ? cfg.w / 2 : 1.5,
        },
      ]}
    />
  );
}
