import React, { useEffect, useRef, useState } from 'react';
import { View, Dimensions } from 'react-native';
import PagerView, { type PagerViewOnPageScrollEventData } from 'react-native-pager-view';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  cancelAnimation,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';

const { width: SCREEN_W } = Dimensions.get('window');

const SLIDE_MS = 8000;

type Props = {
  slides: { key: string; render: () => React.ReactNode }[];
  height: number;
  onIndexChange?: (i: number) => void;
  /** Shared value updated to position+offset (0 = slide 0, 1 = slide 1, etc.). */
  progress?: SharedValue<number>;
};

const AnimatedPager = Animated.createAnimatedComponent(PagerView);

/**
 * Auto-swiping carousel with progress dots that fill over SLIDE_MS.
 * Active dot expands into a pill; inner bar fills 0→100% over 8s.
 * User swipe resets timer.
 */
export function HeroCarousel({ slides, height, onIndexChange, progress }: Props) {
  const pagerRef = useRef<PagerView>(null);
  const [active, setActive] = useState(0);
  const fill = useSharedValue(0); // 0..1 active dot fill
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start the active-dot fill animation + schedule next page
  const startTimer = (idx: number) => {
    if (timer.current) clearTimeout(timer.current);
    cancelAnimation(fill);
    fill.value = 0;
    fill.value = withTiming(1, { duration: SLIDE_MS, easing: Easing.linear });
    timer.current = setTimeout(() => {
      const next = (idx + 1) % slides.length;
      pagerRef.current?.setPage(next);
    }, SLIDE_MS);
  };

  useEffect(() => {
    startTimer(active);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      cancelAnimation(fill);
    };
  }, [active, slides.length]);

  const onPageSelected = (e: { nativeEvent: { position: number } }) => {
    const i = e.nativeEvent.position;
    setActive(i);
    onIndexChange?.(i);
  };

  const onPageScroll = (e: { nativeEvent: PagerViewOnPageScrollEventData }) => {
    if (progress) {
      progress.value = e.nativeEvent.position + e.nativeEvent.offset;
    }
  };

  // Pause auto-advance during user drag
  const onPageScrollStateChanged = (e: { nativeEvent: { pageScrollState: 'idle' | 'dragging' | 'settling' } }) => {
    if (e.nativeEvent.pageScrollState === 'dragging') {
      if (timer.current) clearTimeout(timer.current);
      cancelAnimation(fill);
    } else if (e.nativeEvent.pageScrollState === 'idle') {
      startTimer(active);
    }
  };

  return (
    <View style={{ width: SCREEN_W }}>
      <AnimatedPager
        ref={pagerRef}
        style={{ width: SCREEN_W, height }}
        initialPage={0}
        onPageSelected={onPageSelected}
        onPageScroll={onPageScroll}
        onPageScrollStateChanged={onPageScrollStateChanged}
      >
        {slides.map((s) => (
          <View key={s.key} style={{ flex: 1 }}>
            {s.render()}
          </View>
        ))}
      </AnimatedPager>

      <View style={{ flexDirection: 'row', alignSelf: 'center', marginTop: 14, gap: 6 }}>
        {slides.map((s, i) => (
          <Dot key={s.key} active={i === active} fill={i === active ? fill : null} />
        ))}
      </View>
    </View>
  );
}

function Dot({
  active,
  fill,
}: {
  active: boolean;
  fill: ReturnType<typeof useSharedValue<number>> | null;
}) {
  const widthAnim = useSharedValue(active ? 28 : 6);
  useEffect(() => {
    widthAnim.value = withTiming(active ? 28 : 6, { duration: 220 });
  }, [active]);

  const containerStyle = useAnimatedStyle(() => ({
    width: widthAnim.value,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E0E7FF',
    overflow: 'hidden',
  }));

  const fillStyle = useAnimatedStyle(() => ({
    width: fill ? `${fill.value * 100}%` : '0%',
    height: 6,
    backgroundColor: '#4F46E5',
  }));

  return (
    <Animated.View style={containerStyle}>
      {active && <Animated.View style={fillStyle} />}
    </Animated.View>
  );
}
