import React, { useEffect, useMemo } from 'react';
import { View, Text, type TextStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  Easing,
} from 'react-native-reanimated';

const fontReg: TextStyle = { fontFamily: 'PlusJakartaSans_400Regular' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

type Greet = { hello: string; tagline: string };

function getGreeting(name?: string): Greet {
  const hr = new Date().getHours();
  const hello =
    hr < 5
      ? `Good night${name ? `, ${name}` : ''}`
      : hr < 12
      ? `Good morning${name ? `, ${name}` : ''}`
      : hr < 17
      ? `Good afternoon${name ? `, ${name}` : ''}`
      : hr < 21
      ? `Good evening${name ? `, ${name}` : ''}`
      : `Good night${name ? `, ${name}` : ''}`;

  const tagline =
    hr < 5
      ? "Rest easy. We'll handle the chores."
      : hr < 12
      ? 'A clean home,\na fresh start.'
      : hr < 17
      ? 'A clean home,\na calm mind.'
      : hr < 21
      ? 'Wind down to\na tidy home.'
      : "Rest easy.\nWe'll handle it.";

  return { hello, tagline };
}

type Props = {
  name?: string;
  active: boolean;
};

/**
 * First slide of the carousel. Greeting + tagline + Zop mascot pop-in.
 *
 * Mascot enters tilted from above:
 *   y: -220 → 0 (spring), rotate: -28 → 18 (spring), scale: 0.6 → 1 (spring)
 * Sequenced with a brief mascot wiggle settle.
 */
export function GreetingHeroCard({ name, active }: Props) {
  const { hello, tagline } = useMemo(() => getGreeting(name), [name]);
  const greetOpacity = useSharedValue(0);
  const tagOpacity = useSharedValue(0);

  useEffect(() => {
    greetOpacity.value = withDelay(220, withTiming(1, { duration: 360, easing: Easing.out(Easing.cubic) }));
    tagOpacity.value = withDelay(360, withTiming(1, { duration: 460, easing: Easing.out(Easing.cubic) }));
  }, []);

  const greetStyle = useAnimatedStyle(() => ({ opacity: greetOpacity.value }));
  const tagStyle = useAnimatedStyle(() => ({
    opacity: tagOpacity.value,
    transform: [{ translateY: (1 - tagOpacity.value) * 8 }],
  }));

  return (
    <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 8, position: 'relative' }}>
      {/* Greeting */}
      <Animated.Text
        style={[
          greetStyle,
          fontReg,
          { fontSize: 16, color: '#9CA3AF', marginTop: 32, maxWidth: '62%' },
        ]}
      >
        {hello}
      </Animated.Text>

      {/* Tagline */}
      <Animated.Text
        style={[
          tagStyle,
          fontExtra,
          {
            fontSize: 38,
            lineHeight: 44,
            color: '#0F172A',
            marginTop: 10,
            letterSpacing: -0.8,
            maxWidth: '62%',
          },
        ]}
      >
        {tagline}
      </Animated.Text>
    </View>
  );
}
