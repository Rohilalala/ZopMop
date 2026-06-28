import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import ZopFull from '../../assets/zop/zop-full.svg';
import { useTheme } from '../context/ThemeContext';

const AMBER = '#F5A300';

interface Props {
  role: 'user' | 'assistant';
  content: string;
  isTyping?: boolean;
}

/**
 * Render assistant text with minimal markdown — only **bold** is supported.
 * Splits the string on `**...**` segments and wraps matches in a bold Text.
 * Anything else passes through verbatim. Doesn't depend on a markdown lib —
 * Llama only ever emits bold per the system prompt.
 */
function renderRich(content: string, baseStyle: object) {
  const parts: React.ReactNode[] = [];
  // Greedy match for **non-empty content**. Lazy quantifier so consecutive
  // bolds don't merge.
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(content)) !== null) {
    if (match.index > last) {
      parts.push(
        <Text key={`p${key++}`} style={baseStyle}>
          {content.slice(last, match.index)}
        </Text>,
      );
    }
    parts.push(
      <Text key={`b${key++}`} style={[baseStyle, { fontWeight: '700' }]}>
        {match[1]}
      </Text>,
    );
    last = re.lastIndex;
  }
  if (last < content.length) {
    parts.push(
      <Text key={`p${key++}`} style={baseStyle}>
        {content.slice(last)}
      </Text>,
    );
  }
  return parts;
}

/**
 * One chat bubble. User side is amber-filled and right-aligned. Assistant
 * side is dark-glass with an amber star avatar to the left. Typing state
 * replaces text with three pulsing amber dots, staggered 0/150/300ms.
 */
export default function ZopChatBubble({ role, content, isTyping = false }: Props) {
  const { isDark, colors: c } = useTheme();

  if (role === 'user') {
    return (
      <View style={styles.row}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{content}</Text>
        </View>
      </View>
    );
  }

  // Assistant bubble + text are theme-aware: dark glass / white text on dark,
  // faint-dark glass / dark text on light (otherwise white-on-light = invisible).
  const aBubble = [
    styles.assistantBubble,
    !isDark && { backgroundColor: 'rgba(13,13,15,0.05)' },
  ];
  const aText = [styles.assistantText, !isDark && { color: c.text }];

  return (
    <View style={styles.assistantRow}>
      <View style={styles.avatar}>
        <ZopFull width={26} height={26} />
      </View>
      <View style={aBubble}>
        {isTyping ? (
          <TypingDots />
        ) : (
          <Text style={aText}>{renderRich(content, aText)}</Text>
        )}
      </View>
    </View>
  );
}

function TypingDots() {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const pulse = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, {
            toValue: 1,
            duration: 450,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(val, {
            toValue: 0.3,
            duration: 450,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      );
    const a = pulse(dot1, 0);
    const b = pulse(dot2, 150);
    const c = pulse(dot3, 300);
    a.start();
    b.start();
    c.start();
    return () => {
      a.stop();
      b.stop();
      c.stop();
    };
  }, [dot1, dot2, dot3]);

  return (
    <View style={styles.typingRow}>
      <Animated.View style={[styles.dot, { opacity: dot1 }]} />
      <Animated.View style={[styles.dot, { opacity: dot2 }]} />
      <Animated.View style={[styles.dot, { opacity: dot3 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  assistantRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  userBubble: {
    backgroundColor: AMBER,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderTopRightRadius: 2,
    maxWidth: '75%',
  },
  userText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 22,
    fontFamily: 'PlusJakartaSans_400Regular',
  },
  avatar: {
    width: 26,
    height: 26,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  assistantBubble: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderTopLeftRadius: 2,
    maxWidth: '75%',
  },
  assistantText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 22,
    fontFamily: 'PlusJakartaSans_400Regular',
  },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 22,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginHorizontal: 3,
    backgroundColor: AMBER,
  },
});
