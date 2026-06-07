// HeroPager — the hero layer as a horizontal, swipeable pager built ENTIRELY
// from core RN components (no react-native-pager-view, so it can't crash on app
// builds that lack that native module — important since the hero layer is
// config-driven via SDUI).
//
// Page 0 is always the existing hero card (passed in as `hero`, with its
// pull-to-refresh easter egg intact). Pages 1..n are promo cards from the SDUI
// `hero_carousel` section. The hero never goes away — it slides left to make
// room for the carousel.
//
// Behaviour is SDUI-controlled (see HeroPagerBehavior):
//   • autoplay     — auto-advance through pages (default on)
//   • intervalMs   — dwell per page; a slide's duration_ms overrides it
//   • loop         — wrap from last page back to the first
//   • restartOnFocus — remount a card when it becomes active (restarts any
//                      animation inside it); off = animations run continuously
// User touch pauses autoplay; it resumes after the gesture settles.

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Dimensions,
  ScrollView,
  StyleSheet,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type TextStyle,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Image as ExpoImage } from 'expo-image';
import { GlassCard } from './GlassCard';
import { PressFx } from '../ui/PressFx';
import { useTheme } from '../../context/ThemeContext';
import type { PromoSlide, SduiAction } from '../../sdui/types';

const { width: SCREEN_W } = Dimensions.get('window');

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };
const fontMed: TextStyle = { fontFamily: 'PlusJakartaSans_500Medium' };

export interface HeroPagerBehavior {
  autoplay?: boolean;
  intervalMs?: number;
  loop?: boolean;
  restartOnFocus?: boolean;
}

export function HeroPager({
  hero,
  heroExtra,
  slides,
  behavior,
  onAction,
  onActiveChange,
}: {
  hero: React.ReactNode;
  /** Rendered directly under the hero on page 0 only (e.g. the live pill), so
   *  it swipes in/out bundled with the first card. */
  heroExtra?: React.ReactNode;
  slides: PromoSlide[];
  behavior?: HeroPagerBehavior;
  onAction: (a: SduiAction) => void;
  /** Reports the active page index (0 = hero) so the parent can choose the
   *  refresh animation per page. */
  onActiveChange?: (index: number) => void;
}) {
  const { isDark } = useTheme();
  const slidesArr = slides ?? [];
  const pageCount = slidesArr.length + 1;

  const autoplay = behavior?.autoplay ?? true;
  const intervalMs = behavior?.intervalMs ?? 4000;
  const loop = behavior?.loop ?? true;
  const restartOnFocus = behavior?.restartOnFocus ?? false;

  const [active, setActive] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Auto-advance. Re-armed whenever `active` changes (so each page gets its own
  // dwell). Paused while the user is dragging.
  useEffect(() => {
    if (!autoplay || pageCount <= 1) return;
    const dwell =
      active >= 1 ? slidesArr[active - 1]?.duration_ms ?? intervalMs : intervalMs;
    const t = setTimeout(() => {
      if (draggingRef.current) return;
      let next = active + 1;
      if (next >= pageCount) {
        if (!loop) return;
        next = 0;
      }
      scrollRef.current?.scrollTo({ x: next * SCREEN_W, animated: true });
    }, dwell);
    return () => clearTimeout(t);
  }, [active, autoplay, intervalMs, loop, pageCount, slidesArr]);

  if (slidesArr.length === 0) return <>{hero}{heroExtra}</>;

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (i !== active) setActive(i);
  };

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScrollBeginDrag={() => { draggingRef.current = true; }}
        onScrollEndDrag={() => { draggingRef.current = false; }}
        onMomentumScrollEnd={onMomentumScrollEnd}
      >
        <View style={{ width: SCREEN_W }}>
          {hero}
          {heroExtra}
        </View>
        {slidesArr.map((s, idx) => (
          <View
            // restartOnFocus: changing the key when `active` changes remounts the
            // card so any animation inside replays from the start on focus.
            key={restartOnFocus ? `${s.key}-${active}` : s.key}
            style={{ width: SCREEN_W }}
          >
            <PromoCard slide={s} isDark={isDark} onPress={() => s.action && onAction(s.action)} />
          </View>
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', alignSelf: 'center', marginTop: 12, gap: 6 }}>
        {Array.from({ length: pageCount }).map((_, i) =>
          i === active ? (
            <ActiveDot
              // key includes active so the fill remounts (restarts at 0) each
              // time this dot becomes the active page.
              key={`active-${active}`}
              durationMs={active >= 1 ? slidesArr[active - 1]?.duration_ms ?? intervalMs : intervalMs}
              animate={autoplay}
              isDark={isDark}
            />
          ) : (
            <View
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(13,13,15,0.18)',
              }}
            />
          ),
        )}
      </View>
    </View>
  );
}

// Active page indicator that fills L→R over the page's dwell, story-style, then
// the carousel advances. With autoplay off it just shows full (static).
function ActiveDot({
  durationMs,
  animate,
  isDark,
}: {
  durationMs: number;
  animate: boolean;
  isDark: boolean;
}) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = 0;
    p.value = animate
      ? withTiming(1, { duration: Math.max(300, durationMs), easing: Easing.linear })
      : 1;
  }, [durationMs, animate]);
  const fillStyle = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }));
  return (
    <View
      style={{
        width: 22,
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(13,13,15,0.12)',
      }}
    >
      <Animated.View style={[{ height: '100%', borderRadius: 3, backgroundColor: '#F5A300' }, fillStyle]} />
    </View>
  );
}

function PromoCard({
  slide,
  isDark,
  onPress,
}: {
  slide: PromoSlide;
  isDark: boolean;
  onPress: () => void;
}) {
  const accent = slide.accent || '#F5A300';
  const onImage = !!slide.image_url;
  const titleColor = onImage ? '#FFFFFF' : isDark ? '#FFFFFF' : '#0D0D0F';
  const bodyColor = onImage ? 'rgba(255,255,255,0.85)' : isDark ? 'rgba(255,255,255,0.6)' : 'rgba(13,13,15,0.6)';
  return (
    <View style={{ marginHorizontal: 20, marginTop: 14 }}>
      <PressFx onPress={onPress}>
        <GlassCard radius={28} hero style={{ padding: 22, minHeight: 184, justifyContent: 'center', overflow: 'hidden' }}>
          {onImage && (
            <>
              {/* expo-image renders static (png/jpg/webp) AND animated (gif/webp) sources. */}
              <ExpoImage
                source={{ uri: slide.image_url }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={200}
              />
              {/* scrim so overlaid text stays legible over any image */}
              <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.38)' }]} />
            </>
          )}
          {!!slide.eyebrow && (
            <Text style={[fontBold, { fontSize: 11, color: accent, letterSpacing: 1.2, textTransform: 'uppercase' }]}>
              {slide.eyebrow}
            </Text>
          )}
          <Text
            style={[
              fontExtra,
              { fontSize: 24, lineHeight: 28, color: titleColor, letterSpacing: -0.5, marginTop: 6, maxWidth: 260 },
            ]}
          >
            {slide.title}
          </Text>
          {!!slide.body && (
            <Text style={[fontMed, { fontSize: 13, color: bodyColor, marginTop: 6, maxWidth: 260 }]}>
              {slide.body}
            </Text>
          )}
          {!!slide.cta && (
            <View style={{ alignSelf: 'flex-start', marginTop: 14, backgroundColor: accent, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999 }}>
              <Text style={[fontBold, { fontSize: 13, color: '#0D0D0F' }]}>{slide.cta}</Text>
            </View>
          )}
        </GlassCard>
      </PressFx>
    </View>
  );
}
