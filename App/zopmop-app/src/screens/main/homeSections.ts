// homeSections.ts — split the SDUI section list into the scrolling feed and the
// blocks HomeScreen renders itself (pinned header / list header / overlay).
import type { SduiSection } from '../../sdui/types';

const EXTRACTED = new Set(['hero_carousel', 'greeting_hero', 'header_promo', 'upcoming_booking']);

export interface HomePartition {
  feed: SduiSection[];
  heroCarousel: Extract<SduiSection, { type: 'hero_carousel' }> | null;
  greetingHero: Extract<SduiSection, { type: 'greeting_hero' }> | null;
  headerPromo: Extract<SduiSection, { type: 'header_promo' }> | null;
}

export function partitionHomeSections(sections: SduiSection[]): HomePartition {
  const find = <T extends SduiSection['type']>(t: T) =>
    (sections.find((s) => s.type === t) ?? null) as Extract<SduiSection, { type: T }> | null;
  return {
    feed: sections.filter((s) => !EXTRACTED.has(s.type)),
    heroCarousel: find('hero_carousel'),
    greetingHero: find('greeting_hero'),
    headerPromo: find('header_promo'),
  };
}
