import React, { useRef, useState } from 'react';
import { View, Text, ScrollView, type TextStyle } from 'react-native';
import PagerView, { type PagerViewOnPageScrollEventData } from 'react-native-pager-view';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Extrapolation,
  interpolate,
} from 'react-native-reanimated';
import { Motion } from '../../constants/tokens';
import { PressFx } from './PressFx';

const AnimatedPager = Animated.createAnimatedComponent(PagerView);

export type SlidingTab = {
  key: string;
  label: string;
  render: () => React.ReactNode;
};

type Props = {
  tabs: SlidingTab[];
  initialIndex?: number;
  onChange?: (index: number) => void;
  className?: string;
};

/**
 * Horizontal sliding tabs: animated indicator follows pager scroll position.
 * GSAP-equivalent: timeline with ScrollTrigger interpolating indicator x as pager scrubs.
 * Uses PagerView for native swipe + Reanimated shared values for the underline.
 */
export function SlidingTabs({ tabs, initialIndex = 0, onChange, className = '' }: Props) {
  const pagerRef = useRef<PagerView>(null);
  const [active, setActive] = useState(initialIndex);
  const [tabWidths, setTabWidths] = useState<number[]>([]);
  const [tabXs, setTabXs] = useState<number[]>([]);

  // shared progress: position + offset combined
  const progress = useSharedValue(initialIndex);

  const handleTabLayout = (i: number) => (e: any) => {
    const { x, width } = e.nativeEvent.layout;
    setTabWidths((prev) => {
      const next = [...prev];
      next[i] = width;
      return next;
    });
    setTabXs((prev) => {
      const next = [...prev];
      next[i] = x;
      return next;
    });
  };

  const indicatorStyle = useAnimatedStyle(() => {
    if (!tabWidths.length || !tabXs.length) return { width: 0, transform: [{ translateX: 0 }] };
    const inputRange = tabs.map((_, i) => i);
    const xs = tabs.map((_, i) => tabXs[i] ?? 0);
    const ws = tabs.map((_, i) => tabWidths[i] ?? 0);
    return {
      width: interpolate(progress.value, inputRange, ws, Extrapolation.CLAMP),
      transform: [
        {
          translateX: interpolate(progress.value, inputRange, xs, Extrapolation.CLAMP),
        },
      ],
    };
  });

  const onPageScroll = (e: { nativeEvent: PagerViewOnPageScrollEventData }) => {
    const { position, offset } = e.nativeEvent;
    progress.value = position + offset;
  };

  const onPageSelected = (e: { nativeEvent: { position: number } }) => {
    const i = e.nativeEvent.position;
    setActive(i);
    onChange?.(i);
  };

  const goTo = (i: number) => {
    pagerRef.current?.setPage(i);
    progress.value = withTiming(i, { duration: Motion.duration.base, easing: Motion.easing.smooth });
  };

  const labelStyle: TextStyle = { fontFamily: 'PlusJakartaSans_600SemiBold' };

  return (
    <View className={`flex-1 ${className}`}>
      <View className="border-b border-border">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 12 }}
        >
          <View className="flex-row relative">
            {tabs.map((t, i) => {
              const isActive = i === active;
              return (
                <PressFx
                  key={t.key}
                  onPress={() => goTo(i)}
                  scale={0.96}
                  onLayout={handleTabLayout(i)}
                  className="px-4 py-3"
                >
                  <Text
                    className={`text-md ${isActive ? 'text-text' : 'text-text-secondary'}`}
                    style={labelStyle}
                  >
                    {t.label}
                  </Text>
                </PressFx>
              );
            })}
            <Animated.View
              pointerEvents="none"
              style={[
                indicatorStyle,
                {
                  position: 'absolute',
                  bottom: 0,
                  height: 3,
                  borderRadius: 2,
                  backgroundColor: '#4F46E5',
                },
              ]}
            />
          </View>
        </ScrollView>
      </View>
      <AnimatedPager
        ref={pagerRef}
        style={{ flex: 1 }}
        initialPage={initialIndex}
        onPageScroll={onPageScroll}
        onPageSelected={onPageSelected}
      >
        {tabs.map((t) => (
          <View key={t.key} style={{ flex: 1 }}>
            {t.render()}
          </View>
        ))}
      </AnimatedPager>
    </View>
  );
}
