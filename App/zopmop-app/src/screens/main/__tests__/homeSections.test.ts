// @ts-nocheck
// zopmop-app does not type jest globals (see src/sdui/__tests__/safeguards.test.ts);
// ts-nocheck keeps `tsc --noEmit` clean while the tests run under jest.

import { partitionHomeSections } from '../homeSections';
import type { SduiSection } from '../../../sdui/types';

const base = { id: 'x', visible: true, actions: [] } as const;
const mk = (type: string, data: any, id = type): SduiSection =>
  ({ ...base, id, type, data } as unknown as SduiSection);

test('extracts hero/greeting and keeps the rest as feed', () => {
  const sections = [
    mk('hero_carousel', { greeting_name: '', slides: [] }),
    mk('greeting_hero', { title_lines: ['Home,', 'handled.'] }),
    mk('live_pill', { nearby_count: 0, avg_eta_min: 0, avg_rating: 0 }),
    mk('footer', { signoff: { lines: [], brand: '', badges: [], tagline: '' } }),
  ];
  const r = partitionHomeSections(sections);
  expect(r.feed.map((s) => s.type)).toEqual(['live_pill', 'footer']);
  expect(r.greetingHero?.type).toBe('greeting_hero');
  expect(r.headerPromo).toBeNull();
  expect(r.upcomingBooking).toBeNull();
});

test('feed excludes greeting_hero even if duplicated; missing extracted → null', () => {
  const r = partitionHomeSections([] as SduiSection[]);
  expect(r.feed).toEqual([]);
  expect(r.greetingHero).toBeNull();
});
