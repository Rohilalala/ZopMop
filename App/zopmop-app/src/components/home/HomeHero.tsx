// HomeHero — static glass hero card matching the ZopMop design system.
// Renders above the SDUI feed: kicker, "Home, handled." headline, search bar,
// Zop mascot peeking from the top-right.
//
// Pull-to-refresh easter egg: when the parent passes shared values for
// `eggTranslateY` / `eggRotation` / `eyeOpacity` / `winkProgress`, the Zop
// detaches from its peeking pose and animates per the parent's choreography.
// Idle state still floats up/down on its own.

import React, { useEffect, useMemo } from 'react';
import { View, Text, type TextStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { GlassCard } from './GlassCard';
import { ZopFlyer } from './ZopFlyer';
import { useTheme } from '../../context/ThemeContext';

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

type Props = {
  name?: string;
  /** SDUI override for the kicker line; falls back to the time-of-day greeting. */
  greeting?: string;
  /** SDUI override for the headline; joined with newlines. Falls back to time-of-day copy. */
  titleLines?: string[];
  /** When false, the Zop mascot is hidden. Defaults to shown. */
  showMascot?: boolean;
  /** Egg translate X in px. */
  eggTranslateX?: SharedValue<number>;
  /** Egg translate Y in px. Added to the idle bob. */
  eggTranslateY?: SharedValue<number>;
  /** Egg scale (1 = normal, 0.43 ≈ small loading-Zop size). */
  eggScale?: SharedValue<number>;
  /** Egg rotation in degrees. Added to the resting -12° tilt. */
  eggRotation?: SharedValue<number>;
  /** Eye visibility (1 = open, 0 = invisible). */
  eyeOpacity?: SharedValue<number>;
  /** Right-eye wink progress (0 open → 1 closed flat line). */
  winkProgress?: SharedValue<number>;
  /** When false, Zop renders body-only (no eyes/mouth). */
  showFace?: boolean;
};

function greetingFor(name?: string) {
  const hr = new Date().getHours();
  const tail = name ? `, ${name}` : '';
  if (hr < 5)  return `Good night${tail}`;
  if (hr < 12) return `Good morning${tail}`;
  if (hr < 17) return `Good afternoon${tail}`;
  if (hr < 21) return `Good evening${tail}`;
  return `Good night${tail}`;
}

// Two-line hero headline that flexes with the time of day. Each variant is
// two short, declarative statements split across the lines — matches the
// confident cadence of "Home, handled." without leaning on the same phrase.
// Service hours wrap by 8pm, so late/early slots route to "book for tomorrow"
// framing instead of implying we're actively dispatching pros.
function headlineFor(): string {
  const hr = new Date().getHours();
  if (hr < 5)  return `Off hours.\nCatch us tomorrow.`;
  if (hr < 12) return `Day starts.\nChores don't.`;
  if (hr < 17) return `Home,\nhandled.`;
  if (hr < 20) return `Day done.\nHouse too.`;
  return `That's a wrap.\nBook ahead.`;
}

export function HomeHero({
  name,
  greeting,
  titleLines,
  showMascot,
  eggTranslateX,
  eggTranslateY,
  eggScale,
  eggRotation,
  eyeOpacity,
  winkProgress,
  showFace = true,
}: Props) {
  const { isDark, colors: c } = useTheme();
  const kicker = useMemo(() => greeting ?? greetingFor(name), [greeting, name]);
  const headline = useMemo(() => (titleLines && titleLines.length ? titleLines.join('\n') : headlineFor()), [titleLines]);

  // Idle bob — always running.
  const float = useSharedValue(0);
  useEffect(() => {
    float.value = withRepeat(
      withTiming(1, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, []);

  // Fallback shared values when the parent doesn't drive the easter egg.
  const noTransX  = useSharedValue(0);
  const noTransY  = useSharedValue(0);
  const noScale   = useSharedValue(1);
  const noRot     = useSharedValue(0);
  const fullEye   = useSharedValue(1);
  const noWink    = useSharedValue(0);

  const tX = eggTranslateX ?? noTransX;
  const tY = eggTranslateY ?? noTransY;
  const sc = eggScale      ?? noScale;
  const rZ = eggRotation   ?? noRot;
  const eO = eyeOpacity    ?? fullEye;
  const wP = winkProgress  ?? noWink;

  const containerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tX.value },
      { translateY: -float.value * 6 + tY.value },
      { rotate: `${-12 + rZ.value}deg` },
      { scale: sc.value },
    ],
  }));

  // Memoise eyeOpacity / winkProgress refs so ZopFlyer doesn't re-mount.
  const eyeRef  = useDerivedValue(() => eO.value);
  const winkRef = useDerivedValue(() => wP.value);

  return (
    <View style={{ marginHorizontal: 20, marginTop: 14 }}>
      <GlassCard radius={28} hero style={{ padding: 22 }}>
        {/* Zop mascot — animatable for the pull-to-refresh easter egg */}
        {showMascot !== false ? (
          <Animated.View
            pointerEvents="none"
            style={[
              containerStyle,
              {
                position: 'absolute',
                top: -6,
                right: -14,
                width: 130,
                height: 130,
                zIndex: 5,
              },
            ]}
          >
            <ZopFlyer
              eyeOpacity={eyeRef}
              winkProgress={winkRef}
              showFace={showFace}
            />
          </Animated.View>
        ) : null}

        <Text
          style={[
            fontBold,
            {
              fontSize: 11,
              color: c.accentOnSurface,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
            },
          ]}
        >
          {kicker}
        </Text>

        <Text
          style={[
            fontExtra,
            {
              fontSize: 26,
              lineHeight: 30,
              color: isDark ? '#FFFFFF' : c.text,
              letterSpacing: -0.6,
              marginTop: 6,
              maxWidth: 240,
            },
          ]}
        >
          {headline}
        </Text>
      </GlassCard>
    </View>
  );
}
