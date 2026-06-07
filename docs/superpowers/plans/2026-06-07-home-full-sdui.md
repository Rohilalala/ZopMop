# Home Full-SDUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every content block of the Home screen (greeting hero, footer content, header Earn-pill promo, upcoming-booking toggle) server-driven via the existing SDUI system, so layout/copy/visibility change from backend config without an app release.

**Architecture:** Extend the existing SDUI section system (`types.ts` union + `registry.tsx` + backend `config_json`). Blocks that render inside the scroll feed (footer) go through `SectionRenderer`. Blocks that are pinned or are the list header (greeting hero, header promo, upcoming-booking) are **extracted** from `page.sections` by a pure `partitionHomeSections()` helper and rendered directly by `HomeScreen` — which already owns those mount points — so the pull-to-refresh shared-value wiring on the hero stays untouched. Each phase ships app + backend (schema/validator/seed/safe-layout) + a forward-only idempotent migration.

**Tech Stack:** React Native (Expo), TypeScript, `@shopify/flash-list`, Go (Fiber BFF), Postgres JSONB (`sdui_page_configs`), `golang-migrate`. Tests: `npx jest` (app), `psql` idempotency checks + `make preflight` (backend).

---

## Conventions used in every phase

- **Typecheck (app):** `cd App/zopmop-app && npx tsc --noEmit -p tsconfig.json` → expect no errors in changed files.
- **Unit tests (app):** `cd App/zopmop-app && npx jest <path>` (jest runs with zero config in this repo).
- **Local DB:** native backend uses the docker Postgres on host port **5433** (`docker-compose.override.yml`). Connect: `PGPASSWORD=localdev123 psql -h localhost -p 5433 -U househelp -d househelp_db`.
- **Migrations:** forward-only, idempotent, guarded `jsonb_set` on the active home row (pattern from `migrations/118`/`119`). Number after the current max on this branch (currently 119 → start at 120); **rebase on develop before merge and renumber if develop advanced.**
- **Manual verify:** after each phase, pull-to-refresh Home on the running sim (light + dark) — SDUI `config_hash` is recomputed per request, so a pull refetches.
- **Commit** after each task; messages use the repo's `fix(...)`/`feat(...)` convention; **no AI trailers** (per user global rules).

---

## Phase 1 — Footer becomes data-driven

Footer is already a feed section (`type: "footer"`); only its data shape + component change. Removes the "Book for later" card by omitting `schedule_card` from config; keeps the sign-off; leaves the trust strip hidden (figures are fabricated).

### Task 1.1: Define `FooterData` shape

**Files:**
- Modify: `App/zopmop-app/src/sdui/types.ts:73`

- [ ] **Step 1: Replace the `FooterData` alias**

In `types.ts`, replace:
```ts
export type FooterData             = Record<string, never>;
```
with:
```ts
export interface FooterScheduleCard { title: string; subtitle: string; action: SduiAction }
export interface FooterTrustColumn  { value: string; label: string }
export interface FooterSignoff      { lines: string[]; brand: string; badges: string[]; tagline: string }
export interface FooterData {
  schedule_card?: FooterScheduleCard | null;
  trust?:         { columns: FooterTrustColumn[] } | null;
  signoff:        FooterSignoff;
}
```

- [ ] **Step 2: Bump the SDUI cache schema version**

`FooterData` shape changed, so cached pages must be invalidated. In `App/zopmop-app/src/hooks/useSduiPage.ts`, find `CACHE_SCHEMA_VERSION` and increment it by 1 (e.g. `2` → `3`).

Run: `cd App/zopmop-app && grep -n "CACHE_SCHEMA_VERSION" src/hooks/useSduiPage.ts`
Expected: one definition line; confirm the new value.

- [ ] **Step 3: Typecheck (expect failures in HomeFooter — fixed next task)**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "HomeFooter|FooterSection|types.ts"`
Expected: errors only in `HomeFooter.tsx`/`FooterSection.tsx` (they don't yet consume the new shape). `types.ts` itself clean.

- [ ] **Step 4: Commit**
```bash
git add App/zopmop-app/src/sdui/types.ts App/zopmop-app/src/hooks/useSduiPage.ts
git commit -m "feat(sdui): typed FooterData (signoff/trust/schedule_card)"
```

### Task 1.2: Render `HomeFooter` from data

**Files:**
- Modify: `App/zopmop-app/src/components/home/HomeFooter.tsx`
- Modify: `App/zopmop-app/src/sdui/sections/FooterSection.tsx`

- [ ] **Step 1: Make `FooterSection` pass typed data through**

In `FooterSection.tsx`, stop ignoring `data`:
```tsx
import { HomeFooter } from '../../components/home/HomeFooter';
import type { FooterData, SduiAction } from '../types';

interface Props { data: FooterData; onAction: (action: SduiAction) => void; }

export function FooterSection({ data, onAction }: Props) {
  return <HomeFooter data={data} onAction={onAction} />;
}
```

- [ ] **Step 2: Make `HomeFooter` consume data**

Change `HomeFooter`'s signature and render blocks conditionally. Replace the top-level `export function HomeFooter()` body:
```tsx
import type { FooterData, SduiAction } from '../../sdui/types';

export function HomeFooter({ data, onAction }: { data: FooterData; onAction: (a: SduiAction) => void }) {
  return (
    <View style={{ marginTop: 14, paddingBottom: 16 }}>
      {data.schedule_card ? <ScheduleCard card={data.schedule_card} onAction={onAction} /> : null}
      {data.trust ? <TrustStrip columns={data.trust.columns} /> : null}
      <Signoff signoff={data.signoff} />
    </View>
  );
}
```
Update `ScheduleCard` to take `{ card, onAction }` and fire `onAction(card.action)` on press (instead of the hardcoded `navigation.navigate('AllServices')`), and render `card.title`/`card.subtitle`. Update `TrustStrip` to map `columns` (drop the hardcoded `TrustCol` literals). Update `Signoff` to take `{ signoff }` and render `signoff.lines.join('\n')`, `signoff.brand`, `signoff.badges`, `signoff.tagline` instead of the hardcoded strings. Keep all existing styles.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "HomeFooter|FooterSection"`
Expected: no output (clean).

- [ ] **Step 4: Commit**
```bash
git add App/zopmop-app/src/components/home/HomeFooter.tsx App/zopmop-app/src/sdui/sections/FooterSection.tsx
git commit -m "feat(sdui): render HomeFooter from FooterData"
```

### Task 1.3: Backend — seed, safe layout, migration

**Files:**
- Modify: `App/househelp-api/migrations/036_seed_sdui_home.up.sql` (footer section `data`)
- Modify: `App/househelp-api/static/safe_layouts/home.json` (footer section `data`)
- Create: `App/househelp-api/migrations/120_footer_data_driven.up.sql`
- Create: `App/househelp-api/migrations/120_footer_data_driven.down.sql`

- [ ] **Step 1: Update seed + safe layout footer data**

In both files, change the footer section's `"data": {}` to:
```json
"data": {
  "signoff": {
    "lines": ["We mop.", "You zop."],
    "brand": "ZopMop",
    "badges": ["Vetted pros", "30-min support", "Refund if unhappy"],
    "tagline": "Built in India · One home at a time"
  }
}
```
(No `schedule_card` → "Book for later" gone. No `trust` → trust strip stays hidden.)

- [ ] **Step 2: Write the forward migration**

`120_footer_data_driven.up.sql`:
```sql
-- 120_footer_data_driven: replace the empty footer data with the typed signoff shape.
-- Idempotent: only fires while the footer data has no signoff yet.
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections,3,data}',
         '{"signoff":{"lines":["We mop.","You zop."],"brand":"ZopMop","badges":["Vetted pros","30-min support","Refund if unhappy"],"tagline":"Built in India · One home at a time"}}'::jsonb)
 WHERE page_id = 'home' AND env = 'production' AND status = 'active'
   AND config_json #>> '{sections,3,type}'           = 'footer'
   AND config_json #>> '{sections,3,data,signoff}'   IS NULL;
```
> Verify the footer index first: `… -tAc "SELECT s->>'type' FROM sdui_page_configs c, jsonb_array_elements(c.config_json->'sections') WITH ORDINALITY t(s,i) WHERE c.page_id='home' AND c.status='active';"` — if `footer` is not at index 3, change `{sections,3,...}` accordingly.

`120_footer_data_driven.down.sql`:
```sql
UPDATE sdui_page_configs
   SET config_json = jsonb_set(config_json, '{sections,3,data}', '{}'::jsonb)
 WHERE page_id = 'home' AND env = 'production' AND status = 'active'
   AND config_json #>> '{sections,3,type}' = 'footer';
```

- [ ] **Step 3: Apply + verify idempotency on the local DB**

Run:
```bash
cd App/househelp-api
PGPASSWORD=localdev123 psql -h localhost -p 5433 -U househelp -d househelp_db -f migrations/120_footer_data_driven.up.sql
PGPASSWORD=localdev123 psql -h localhost -p 5433 -U househelp -d househelp_db -f migrations/120_footer_data_driven.up.sql
```
Expected: first `UPDATE 1`, second `UPDATE 0`.

- [ ] **Step 4: Manual verify**

Pull-to-refresh Home (light + dark). Footer shows "We mop. You zop." sign-off; **no "Book for later" card**; no trust strip.

- [ ] **Step 5: Commit**
```bash
git add App/househelp-api/migrations/120_footer_data_driven.up.sql App/househelp-api/migrations/120_footer_data_driven.down.sql App/househelp-api/migrations/036_seed_sdui_home.up.sql App/househelp-api/static/safe_layouts/home.json
git commit -m "feat(sdui): data-driven home footer (removes Book-for-later via config)"
```

---

## Phase 2 — `greeting_hero` section

Introduces the extraction helper. The hero stays the `FlashList` `ListHeaderComponent` rendered by `HomeScreen` (shared-value refresh props untouched); config supplies optional greeting/title overrides with time-of-day fallback.

### Task 2.1: Add the `greeting_hero` type + registry no-op

**Files:**
- Modify: `App/zopmop-app/src/sdui/types.ts`
- Modify: `App/zopmop-app/src/sdui/registry.tsx`

- [ ] **Step 1: Add the data interface + union member**

In `types.ts`, after `FooterData` add:
```ts
export interface GreetingHeroData { greeting?: string; title_lines?: string[]; show_mascot?: boolean }
```
Add to the `SduiSection` union:
```ts
  | (SduiSectionBase & { type: 'greeting_hero'; data: GreetingHeroData })
```

- [ ] **Step 2: Add a null registry entry (extracted, never feed-rendered)**

In `registry.tsx`, add:
```tsx
function GreetingHeroEntry(_props: RegistryProps) { return null; } // extracted by HomeScreen; never rendered in-feed
```
and add `greeting_hero: GreetingHeroEntry,` to `SECTION_REGISTRY`.

- [ ] **Step 3: Bump `CACHE_SCHEMA_VERSION`** in `useSduiPage.ts` (union shape changed).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "registry|types"`
Expected: clean (registry remains exhaustive over `SduiSectionType`).

- [ ] **Step 5: Commit**
```bash
git add App/zopmop-app/src/sdui/types.ts App/zopmop-app/src/sdui/registry.tsx App/zopmop-app/src/hooks/useSduiPage.ts
git commit -m "feat(sdui): add greeting_hero section type"
```

### Task 2.2: TDD the `partitionHomeSections` helper

**Files:**
- Create: `App/zopmop-app/src/screens/main/homeSections.ts`
- Test: `App/zopmop-app/src/screens/main/__tests__/homeSections.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
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
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../homeSections'`)

Run: `npx jest src/screens/main/__tests__/homeSections.test.ts`

- [ ] **Step 3: Implement the helper**
```ts
// homeSections.ts — split the SDUI section list into the scrolling feed and the
// blocks HomeScreen renders itself (pinned header / list header / overlay).
import type { SduiSection } from '../../sdui/types';

const EXTRACTED = new Set(['hero_carousel', 'greeting_hero', 'header_promo', 'upcoming_booking']);

export interface HomePartition {
  feed: SduiSection[];
  greetingHero: Extract<SduiSection, { type: 'greeting_hero' }> | null;
  headerPromo: Extract<SduiSection, { type: 'header_promo' }> | null;
  upcomingBooking: Extract<SduiSection, { type: 'upcoming_booking' }> | null;
}

export function partitionHomeSections(sections: SduiSection[]): HomePartition {
  const find = <T extends SduiSection['type']>(t: T) =>
    (sections.find((s) => s.type === t) ?? null) as Extract<SduiSection, { type: T }> | null;
  return {
    feed: sections.filter((s) => !EXTRACTED.has(s.type)),
    greetingHero: find('greeting_hero'),
    headerPromo: find('header_promo'),
    upcomingBooking: find('upcoming_booking'),
  };
}
```
> `header_promo` / `upcoming_booking` types are added in Phases 3–4; the `find()` calls compile now because they return null until those union members exist. If `tsc` complains about the literal types before they exist, add the two union members in this task as well (data shapes defined in their phases) — they're harmless empty extracted types.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx jest src/screens/main/__tests__/homeSections.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**
```bash
git add App/zopmop-app/src/screens/main/homeSections.ts App/zopmop-app/src/screens/main/__tests__/homeSections.test.ts
git commit -m "feat(sdui): partitionHomeSections helper (feed vs extracted)"
```

### Task 2.3: Wire hero data through HomeScreen + HomeHero

**Files:**
- Modify: `App/zopmop-app/src/screens/main/HomeScreen.tsx:521` (sections filter → partition)
- Modify: `App/zopmop-app/src/components/home/HomeHero.tsx`

- [ ] **Step 1: Use the partition in HomeScreen**

Replace `const sections = (page?.sections ?? []).filter((s) => s.type !== 'hero_carousel');` with:
```tsx
const part = partitionHomeSections(page?.sections ?? []);
const sections = part.feed;
const heroData = part.greetingHero?.data;
```
Import `partitionHomeSections` from `./homeSections`. Pass hero data into the existing `Header` (the `<HomeHero .../>` `ListHeaderComponent`) alongside the current shared-value props:
```tsx
const Header = (
  <HomeHero
    name={user?.name ?? undefined}
    greeting={heroData?.greeting}
    titleLines={heroData?.title_lines}
    showMascot={heroData?.show_mascot}
    eggTranslateX={heroTransX}
    eggTranslateY={heroTransY}
    eggScale={heroScale}
    eggRotation={heroRotZ}
    eyeOpacity={heroEye}
    winkProgress={heroWink}
    showFace={heroShowFace}
  />
);
```

- [ ] **Step 2: Consume the overrides in HomeHero**

In `HomeHero.tsx`, add props `greeting?: string; titleLines?: string[]; showMascot?: boolean;`. Use them with fallback to the existing time-of-day logic:
```tsx
const kicker = useMemo(() => greeting ?? greetingFor(name), [greeting, name]);
const headline = useMemo(() => (titleLines && titleLines.length ? titleLines.join('\n') : headlineFor()), [titleLines]);
```
Gate the mascot block with `showMascot !== false` (default shown).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "HomeScreen|HomeHero"`
Expected: clean.

- [ ] **Step 4: Commit**
```bash
git add App/zopmop-app/src/screens/main/HomeScreen.tsx App/zopmop-app/src/components/home/HomeHero.tsx
git commit -m "feat(sdui): drive HomeHero copy/visibility from greeting_hero section"
```

### Task 2.4: Backend — add `greeting_hero` to schema/validator/seed + migration

**Files:**
- Modify: `App/househelp-api/schemas/sdui_page_config.json:137` (type enum)
- Modify: `App/househelp-api/internal/bff/validator.go:40-44` (allowed set)
- Modify: `App/househelp-api/migrations/036_seed_sdui_home.up.sql` + `static/safe_layouts/home.json` (insert hero section)
- Create: `App/househelp-api/migrations/121_greeting_hero_section.up.sql` + `.down.sql`

- [ ] **Step 1: Allow the new type (schema + validator)**

In `sdui_page_config.json` add `"greeting_hero"` to the section `type` enum. In `validator.go` add `"greeting_hero": {},` to the allowed-types map (alongside `live_pill` etc.).

- [ ] **Step 2: Add the hero section to seed + safe layout**

Insert as the first section (index 0, before `live`) in both files:
```json
{ "id": "hero", "type": "greeting_hero", "visible": true,
  "data": { "title_lines": ["Home,", "handled."], "show_mascot": true } }
```
> Adding at index 0 shifts later indices — update Phase 1's `{sections,3,...}` footer assumption to `{sections,4,...}` if the hero precedes it. **Re-run the index check query** and fix any migration paths accordingly.

- [ ] **Step 3: Migration to insert hero into existing active config**

`121_greeting_hero_section.up.sql` (idempotent — only when absent):
```sql
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json, '{sections}',
         ('[{"id":"hero","type":"greeting_hero","visible":true,"data":{"title_lines":["Home,","handled."],"show_mascot":true}}]'::jsonb)
           || (config_json->'sections'))
 WHERE page_id='home' AND env='production' AND status='active'
   AND NOT (config_json->'sections') @> '[{"type":"greeting_hero"}]'::jsonb;
```
`.down.sql`: remove it —
```sql
UPDATE sdui_page_configs
   SET config_json = jsonb_set(config_json, '{sections}',
         (SELECT coalesce(jsonb_agg(s), '[]'::jsonb)
            FROM jsonb_array_elements(config_json->'sections') s
           WHERE s->>'type' <> 'greeting_hero'))
 WHERE page_id='home' AND env='production' AND status='active';
```

- [ ] **Step 4: Apply + idempotency**

Run the up migration twice (expect `UPDATE 1` then `UPDATE 0`); then `make preflight` from `App/househelp-api` (validator must accept the new type).

- [ ] **Step 5: Manual verify** — pull-to-refresh; hero still shows "Home, handled." and the refresh easter-egg still flies the mascot. Edit the config `title_lines` in the DB, refresh, confirm copy changes with no app rebuild.

- [ ] **Step 6: Commit**
```bash
git add App/househelp-api/schemas/sdui_page_config.json App/househelp-api/internal/bff/validator.go App/househelp-api/migrations/121_greeting_hero_section.up.sql App/househelp-api/migrations/121_greeting_hero_section.down.sql App/househelp-api/migrations/036_seed_sdui_home.up.sql App/househelp-api/static/safe_layouts/home.json
git commit -m "feat(sdui): greeting_hero backend type + seed + migration"
```

---

## Phase 3 — `header_promo` (Earn pill)

### Task 3.1: Type + registry + extraction wiring

**Files:**
- Modify: `App/zopmop-app/src/sdui/types.ts`, `registry.tsx`, `hooks/useSduiPage.ts`
- Modify: `App/zopmop-app/src/screens/main/HomeScreen.tsx`, `components/home/HomeHeader.tsx`
- Modify: `App/zopmop-app/src/sdui/allowlist.ts` (if the promo action target screen isn't allowed)

- [ ] **Step 1: Add the type**

`types.ts`:
```ts
export interface HeaderPromoData { label: string; amount_label?: string; action: SduiAction; visible?: boolean }
```
Union member: `| (SduiSectionBase & { type: 'header_promo'; data: HeaderPromoData })`. Add `header_promo: () => null` entry to `SECTION_REGISTRY` (extracted). Bump `CACHE_SCHEMA_VERSION`.

- [ ] **Step 2: Pass promo to HomeHeader**

In `HomeScreen.tsx`, from the existing `part`, compute `const headerPromo = part.headerPromo?.data;` and pass `promo={headerPromo}` to `<HomeHeader .../>`.

- [ ] **Step 3: Render promo in HomeHeader**

Add prop `promo?: HeaderPromoData; onAction?: (a: SduiAction) => void;`. When `promo && promo.visible !== false`, render the existing Earn pill with `promo.label` (+ optional `promo.amount_label`) and fire `onAction?.(promo.action)` on press. When `promo` is undefined, keep the current hardcoded "Earn ₹150" → `navigation.navigate('ReferralEarn')` (back-compat). When `promo?.visible === false`, render nothing for the pill. Pass `handleAction` from HomeScreen as `onAction`.

- [ ] **Step 4: Allowlist check**

Run: `grep -n "ReferralEarn" App/zopmop-app/src/sdui/allowlist.ts`
If missing, add `'ReferralEarn'` to `ALLOWED_SCREENS` (the promo action is `{type:'navigate', screen:'ReferralEarn'}` and `sanitizeAction` drops unknown screens).

- [ ] **Step 5: Typecheck → clean. Commit.**
```bash
git add App/zopmop-app/src/sdui App/zopmop-app/src/hooks/useSduiPage.ts App/zopmop-app/src/screens/main/HomeScreen.tsx App/zopmop-app/src/components/home/HomeHeader.tsx
git commit -m "feat(sdui): header_promo drives the Earn pill"
```

### Task 3.2: Backend — schema/validator/seed/migration

**Files:** `schemas/sdui_page_config.json`, `internal/bff/validator.go`, `036_*.up.sql`, `static/safe_layouts/home.json`, new `122_header_promo_section.{up,down}.sql`.

- [ ] **Step 1:** Add `"header_promo"` to the schema enum + validator allowed set.
- [ ] **Step 2:** Add the section to seed + safe layout:
```json
{ "id": "header_promo", "type": "header_promo", "visible": true,
  "data": { "label": "Earn ₹150", "action": { "trigger": "tap", "type": "navigate", "screen": "ReferralEarn" }, "visible": true } }
```
- [ ] **Step 3:** Migration `122` (prepend, idempotent guard `NOT (… @> '[{"type":"header_promo"}]')`), mirroring Task 2.4's insert/remove pattern.
- [ ] **Step 4:** Apply twice (`UPDATE 1`/`UPDATE 0`); `make preflight`.
- [ ] **Step 5:** Manual verify — Earn pill shows from config; flip `data.visible` to `false` in DB, refresh, pill disappears with no rebuild.
- [ ] **Step 6:** Commit (`feat(sdui): header_promo backend type + seed + migration`).

---

## Phase 4 — `upcoming_booking` enable/disable toggle

Smallest phase: visibility gate only; the component keeps its client fetch + polling.

### Task 4.1: Type + gate the overlay

**Files:** `types.ts`, `registry.tsx`, `hooks/useSduiPage.ts`, `screens/main/HomeScreen.tsx`.

- [ ] **Step 1:** Add type:
```ts
export interface UpcomingBookingData { visible?: boolean }
```
Union member `| (SduiSectionBase & { type: 'upcoming_booking'; data: UpcomingBookingData })`; `upcoming_booking: () => null` registry entry; bump `CACHE_SCHEMA_VERSION`.

- [ ] **Step 2:** Gate the overlay in `HomeScreen.tsx`. Replace `<UpcomingBookingIndicator />` (line ~606) with:
```tsx
{part.upcomingBooking && part.upcomingBooking.data.visible !== false && part.upcomingBooking.visible !== false
  ? <UpcomingBookingIndicator />
  : null}
```
> Note: if the `upcoming_booking` section is absent entirely, the indicator does NOT render. To preserve today's always-on behavior until config ships, default-render when the section is absent: `const showUpcoming = part.upcomingBooking ? (part.upcomingBooking.data.visible !== false) : true;` then `{showUpcoming ? <UpcomingBookingIndicator/> : null}`. Use this default-on form.

- [ ] **Step 3:** Typecheck → clean. Commit (`feat(sdui): upcoming_booking visibility toggle`).

### Task 4.2: Backend — schema/validator/seed/migration

**Files:** `schemas/sdui_page_config.json`, `validator.go`, `036_*.up.sql`, `static/safe_layouts/home.json`, new `123_upcoming_booking_toggle.{up,down}.sql`.

- [ ] **Step 1:** Add `"upcoming_booking"` to enum + validator allowed set.
- [ ] **Step 2:** Add section to seed + safe layout (append):
```json
{ "id": "upcoming_booking", "type": "upcoming_booking", "visible": true, "data": { "visible": true } }
```
- [ ] **Step 3:** Migration `123` (append, idempotent guard), same pattern as before.
- [ ] **Step 4:** Apply twice (`UPDATE 1`/`UPDATE 0`); `make preflight`.
- [ ] **Step 5:** Manual verify — with an upcoming booking present, the pill shows; set `data.visible=false` in DB, refresh, pill stays hidden even with a live booking.
- [ ] **Step 6:** Commit (`feat(sdui): upcoming_booking backend type + seed + migration`).

---

## Final verification

- [ ] `cd App/zopmop-app && npx tsc --noEmit -p tsconfig.json` → clean.
- [ ] `cd App/zopmop-app && npx jest` → all pass (incl. `homeSections` + existing `safeguards`).
- [ ] `cd App/househelp-api && make preflight` → green (validator accepts all 4 new types).
- [ ] Re-run every new migration once more → each `UPDATE 0` (idempotent).
- [ ] Pull-to-refresh Home (light + dark): hero copy, footer sign-off (no Book-for-later), Earn pill, and upcoming-booking visibility all driven by config; refresh easter-egg intact.
- [ ] Confirm the home `sections` order in the DB matches intended render order; `SectionRenderer` drops the four extracted types from the feed (each maps to a null registry entry).

## Notes / risks (from the spec)

- **Section index drift:** every phase that inserts a section shifts array indices used by earlier `jsonb_set` paths. Re-run the index-check query before writing each migration and after each insert.
- **Migration numbering:** branch is behind `develop`; renumber 120–123 above the real max and rebase before merging PR. Backend migrations are forward-only.
- **Cache version:** every union-shape change bumps `CACHE_SCHEMA_VERSION` so stale cached pages are dropped.
- **Hero coupling:** Phase 2 deliberately keeps the hero as `HomeScreen`'s `ListHeaderComponent` (not via `SectionRenderer`) so the `heroTransX/Y/scale/rotZ/eye/wink` + `heroShowFace` refresh wiring is untouched — this is a deliberate simplification of the spec's context approach.
