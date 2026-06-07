// HeroPager — the hero layer as a horizontal, swipeable pager built ENTIRELY
// from core RN components (no react-native-pager-view, so it can't crash on app
// builds that lack that native module — important since the hero layer is
// config-driven via SDUI).
//
// Page 0 is always the existing hero card (passed in as `hero`, with its
// pull-to-refresh easter egg intact). Pages 1..n are promo cards from the SDUI
// `hero_carousel` section. The hero never goes away — it just slides left to
// make room for the carousel. With no promo slides, the hero renders alone.

import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  Dimensions,
  ScrollView,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type TextStyle,
} from 'react-native';
import { GlassCard } from './GlassCard';
import { PressFx } from '../ui/PressFx';
import { useTheme } from '../../context/ThemeContext';
import type { PromoSlide, SduiAction } from '../../sdui/types';

const { width: SCREEN_W } = Dimensions.get('window');

const fontBold: TextStyle = { fontFamily: 'PlusJakartaSans_700Bold' };
const fontExtra: TextStyle = { fontFamily: 'PlusJakartaSans_800ExtraBold' };

export function HeroPager({
  hero,
  slides,
  onAction,
}: {
  hero: React.ReactNode;
  slides: PromoSlide[];
  onAction: (a: SduiAction) => void;
}) {
  const { isDark } = useTheme();
  const [active, setActive] = useState(0);
  const scrollX = useRef(0);

  // No promo cards → render the hero alone (no pager, no dots).
  if (!slides || slides.length === 0) return <>{hero}</>;

  const pageCount = slides.length + 1;

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (i !== active) setActive(i);
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.current = e.nativeEvent.contentOffset.x;
  };

  return (
    <View>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        onMomentumScrollEnd={onMomentumScrollEnd}
      >
        <View style={{ width: SCREEN_W }}>{hero}</View>
        {slides.map((s) => (
          <View key={s.key} style={{ width: SCREEN_W }}>
            <PromoCard slide={s} isDark={isDark} onPress={() => s.action && onAction(s.action)} />
          </View>
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', alignSelf: 'center', marginTop: 12, gap: 6 }}>
        {Array.from({ length: pageCount }).map((_, i) => (
          <View
            key={i}
            style={{
              width: i === active ? 22 : 6,
              height: 6,
              borderRadius: 3,
              backgroundColor:
                i === active ? '#F5A300' : isDark ? 'rgba(255,255,255,0.25)' : 'rgba(13,13,15,0.18)',
            }}
          />
        ))}
      </View>
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
  return (
    <View style={{ marginHorizontal: 20, marginTop: 14 }}>
      <PressFx onPress={onPress}>
        <GlassCard radius={28} hero style={{ padding: 22, minHeight: 150, justifyContent: 'center' }}>
          {!!slide.eyebrow && (
            <Text style={[fontBold, { fontSize: 11, color: accent, letterSpacing: 1.2, textTransform: 'uppercase' }]}>
              {slide.eyebrow}
            </Text>
          )}
          <Text
            style={[
              fontExtra,
              { fontSize: 24, lineHeight: 28, color: isDark ? '#FFFFFF' : '#0D0D0F', letterSpacing: -0.5, marginTop: 6, maxWidth: 260 },
            ]}
          >
            {slide.title}
          </Text>
          {!!slide.body && (
            <Text
              style={[
                { fontFamily: 'PlusJakartaSans_500Medium', fontSize: 13, color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(13,13,15,0.6)', marginTop: 6, maxWidth: 260 },
              ]}
            >
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
