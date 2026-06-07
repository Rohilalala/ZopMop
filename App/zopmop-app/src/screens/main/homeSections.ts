// homeSections.ts — split the SDUI section list into the scrolling feed and the
// blocks HomeScreen renders itself (pinned header / list header / overlay).
import type { SduiSection } from '../../sdui/types';

// live_pill is extracted so it can ride inside the hero pager's first page
// (bundled with the hero card — they swipe in/out together).
const EXTRACTED = new Set(['hero_carousel', 'greeting_hero', 'header_promo', 'upcoming_booking', 'live_pill']);

export interface HomePartition {
  feed: SduiSection[];
  heroCarousel: Extract<SduiSection, { type: 'hero_carousel' }> | null;
  greetingHero: Extract<SduiSection, { type: 'greeting_hero' }> | null;
  headerPromo: Extract<SduiSection, { type: 'header_promo' }> | null;
  upcomingBooking: Extract<SduiSection, { type: 'upcoming_booking' }> | null;
  livePill: Extract<SduiSection, { type: 'live_pill' }> | null;
}

export function partitionHomeSections(sections: SduiSection[]): HomePartition {
  const find = <T extends SduiSection['type']>(t: T) =>
    (sections.find((s) => s.type === t) ?? null) as Extract<SduiSection, { type: T }> | null;
  return {
    feed: sections.filter((s) => !EXTRACTED.has(s.type)),
    heroCarousel: find('hero_carousel'),
    greetingHero: find('greeting_hero'),
    headerPromo: find('header_promo'),
    upcomingBooking: find('upcoming_booking'),
    livePill: find('live_pill'),
  };
}
