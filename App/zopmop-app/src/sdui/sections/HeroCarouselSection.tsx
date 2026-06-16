// SDUI adapter for the home hero carousel. Thin wrapper — all real visual
// behaviour lives in HeroCarousel + PromoCard. We just bridge the SDUI data
// shape (PromoSlide[]) to the existing render-prop API.

import React, { useMemo } from 'react';

import { HeroCarousel } from '../../components/home/HeroCarousel';
import { PromoCard } from '../../components/home/PromoCard';
import type { HeroCarouselData, PromoSlide, SduiAction } from '../types';

interface Props {
  data: HeroCarouselData;
  onAction: (action: SduiAction) => void;
  height?: number;
}

const DEFAULT_HEIGHT = 280;

export function HeroCarouselSection({ data, onAction, height }: Props) {
  const slides = useMemo(
    () =>
      (data.slides ?? []).map((slide: PromoSlide) => ({
        key: slide.key,
        render: () => (
          <PromoCard
            promo={{
              key: slide.key,
              eyebrow: slide.eyebrow,
              title: slide.title,
              body: slide.body,
              cta: slide.cta,
              bg: slide.bg,
              accent: slide.accent,
              onPress: slide.action ? () => onAction(slide.action) : undefined,
            }}
          />
        ),
      })),
    [data.slides, onAction],
  );

  if (slides.length === 0) return null;

  return <HeroCarousel slides={slides} height={height ?? DEFAULT_HEIGHT} />;
}
