// SDUI section registry. Maps section.type → renderer component.
//
// Each registry entry is a small adapter that pulls `section.data` out and
// passes it to the underlying section component, so the SectionRenderer can
// stay generic over `(section, onAction, position)`.

import React from 'react';

import { FooterSection }       from './sections/FooterSection';
import { HeroCarouselSection } from './sections/HeroCarouselSection';
import { LivePillSection }     from './sections/LivePillSection';
import { ServiceGridSection }  from './sections/ServiceGridSection';
import { UsualsRowSection }    from './sections/UsualsRowSection';
import type { SduiAction, SduiSection, SduiSectionType } from './types';

export interface RegistryProps {
  section:  SduiSection;
  onAction: (action: SduiAction) => void;
  position: number;
}

export type SectionComponent = React.ComponentType<RegistryProps>;

function HeroEntry({ section, onAction }: RegistryProps) {
  if (section.type !== 'hero_carousel') return null;
  return (
    <HeroCarouselSection
      data={section.data}
      onAction={onAction}
      height={section.layout?.height}
    />
  );
}

function LivePillEntry({ section, onAction }: RegistryProps) {
  if (section.type !== 'live_pill') return null;
  return <LivePillSection data={section.data} onAction={onAction} />;
}

function UsualsEntry({ section, onAction }: RegistryProps) {
  if (section.type !== 'usuals_row') return null;
  return <UsualsRowSection data={section.data} onAction={onAction} />;
}

function ServiceGridEntry({ section, onAction }: RegistryProps) {
  if (section.type !== 'service_grid') return null;
  return <ServiceGridSection data={section.data} onAction={onAction} />;
}

function FooterEntry({ section, onAction }: RegistryProps) {
  if (section.type !== 'footer') return null;
  return <FooterSection data={section.data} onAction={onAction} />;
}

function GreetingHeroEntry(_props: RegistryProps) { return null; } // extracted by HomeScreen; never rendered in-feed

export const SECTION_REGISTRY: Record<SduiSectionType, SectionComponent> = {
  hero_carousel: HeroEntry,
  live_pill:     LivePillEntry,
  usuals_row:    UsualsEntry,
  service_grid:  ServiceGridEntry,
  footer:        FooterEntry,
  greeting_hero: GreetingHeroEntry,
};
