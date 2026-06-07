# Home screen → full SDUI (except chrome)

**Date:** 2026-06-07
**Status:** Approved (design) — pending implementation plan
**Area:** `App/zopmop-app` (SDUI client) + `App/househelp-api` (BFF/config)

## Goal

Make every *content* block of the Home screen server-driven via the existing SDUI
system, so layout, ordering, copy, and visibility can change from backend config
without an app release. Interactive logic stays in app components; the backend
controls **which blocks render, in what order, with what data**.

## Scope

**In scope — config-driven SDUI sections:**
- Greeting hero ("Home, handled") — copy + visibility (animation preserved)
- Footer content (sign-off, trust strip, schedule card) — data-driven
- Header "Earn ₹150" promo pill — copy/amount/visibility
- Already SDUI (no change needed): `live_pill`, `usuals_row`, `service_grid`, `hero_carousel`

**Out of scope — app chrome (treated like the bottom nav bar):**
- Bottom navigation bar
- Floating cart bar (`HomeCartBar`) — pinned, reads live cart state
- Upcoming-booking indicator (`UpcomingBookingIndicator`) — pinned, reads booking state
- Location selector + profile avatar interactivity (location-picker modal stays app-side)
- Background backdrop (`ScreenBg`/`Bloom`) — theme-driven, not content

## SDUI model (confirmed)

"Structure + content": config drives section **presence, order, and data**. The
section's interactive behavior lives in the app component, which the registry
mounts. No server-shipped logic.

## Current architecture (reference)

- `src/hooks/useSduiPage.ts` — fetches `GET {BASE_URL}/sdui/page/home`, caches, sanitizes.
- `src/sdui/SectionRenderer.tsx` — looks up `section.type` in `SECTION_REGISTRY`, renders.
- `src/sdui/registry.tsx` — `SECTION_REGISTRY: Record<SduiSectionType, Component>`.
- `src/sdui/types.ts` — per-type `*Data` interfaces + discriminated `SduiSection` union + `SduiSectionType`.
- `src/sdui/safeguards.ts` — `sanitizePage` validates/coerces incoming config.
- `src/screens/main/HomeScreen.tsx` — renders pinned `HomeHeader`, then a `FlashList`
  whose `data = page.sections` (minus `hero_carousel`, which is extracted) and whose
  `ListHeaderComponent` is the hardcoded `HomeHero`; plus pinned `HomeCartBar` /
  `UpcomingBookingIndicator` overlays. `renderItem` delegates to `SectionRenderer`.
- Backend: `schemas/sdui_page_config.json` (section `type` enum), `internal/bff/validator.go`
  (allowed-type set + checks), seed `migrations/036_seed_sdui_home.up.sql`, mirror
  `static/safe_layouts/home.json`. Config stored in `sdui_page_configs.config_json` (JSONB).

## Design

### 1. Footer → data-driven
Change `FooterData` from `Record<string, never>` to:
```
FooterData {
  schedule_card?: { title, subtitle, action } | null
  trust?: { columns: { value, label }[] } | null
  signoff: { lines: string[], brand: string, badges: string[], tagline: string }
}
```
`FooterSection` passes `data` to `HomeFooter`, which renders each block only when
present. The "Book for later" card is removed by **omitting `schedule_card`** in
config (no app release needed to toggle it). `TrustStrip` (currently dead code) is
wired to `trust` data; render only if present. This subsumes the standalone
"remove Book for later" request.

### 2. `greeting_hero` section (new type)
```
GreetingHeroData { greeting?: string, title_lines: string[], show_mascot?: boolean }
```
- App component: existing `HomeHero`, still rendered as the `FlashList`
  `ListHeaderComponent` so it stays first and inside the scroll.
- Refresh easter-egg: the pull-to-refresh choreography stays in `HomeScreen`
  (it owns `RefreshControl` + shared values). The hero reaches those shared
  values through a new `RefreshChoreographyContext` — `HomeScreen` is the
  provider, the hero section is the consumer. Animation behavior unchanged.
- `HomeScreen` extracts the `greeting_hero` entry from `page.sections` (same
  pattern used today for `hero_carousel`) and feeds its data to the
  `ListHeaderComponent`; it is not rendered inline in the feed list.

### 3. Header Earn-pill promo
```
HeaderPromoData { label: string, amount_label?: string, action: SduiAction, visible: boolean }
```
- Modeled as a `header_promo` entry the app **extracts** from `page.sections`
  (like `hero_carousel`/`greeting_hero`) and feeds to the pinned `HomeHeader`.
  Not rendered in the scroll feed.
- Location selector + avatar remain app chrome.

### Per-block change surface (the repeating pattern)
**App:** `types.ts` (add `*Data` + union member + it flows into `SduiSectionType`),
`registry.tsx` (add entry; for extracted types still register a no-op/None so the
renderer drops them from the feed), `sections/*Section.tsx` adapter where rendered
in-feed, `safeguards.ts` sanitizer for the new shape.
**Backend:** `schemas/sdui_page_config.json` `type` enum, `validator.go` allowed-set,
seed `036` + `safe_layouts/home.json` (add/extend blocks), forward-only migration
(idempotent guarded `jsonb_set` / archive+reinsert, like `118`/`119`) to update
already-seeded DBs. Add a `sources.go` resolver only if a block needs server data
(none required for phase 1–3; greeting name stays client-side).

### Background
`ScreenBg`/`Bloom` stays app-side (theme backdrop). Out of scope; a page-level
config bg token can be added later if wanted.

## Rollout (incremental)

- **Phase 1 — Footer data-driven.** Establishes the data-driven pattern; lands the
  "remove Book for later" change via config. (Note: working tree currently has a
  partial app-only edit removing `ScheduleCard` from `HomeFooter`; Phase 1 reworks
  `HomeFooter` to be data-driven and supersedes it.)
- **Phase 2 — `greeting_hero`** + `RefreshChoreographyContext`.
- **Phase 3 — `header_promo`** for the Earn pill.

Each phase: app changes + backend schema/validator + seed + safe-layout + a
forward-only migration, then verify by pull-to-refresh on the running stack.

## Risks / watch-outs

- **Hero ↔ refresh coupling** is the highest-risk piece; the context indirection
  must preserve the exact shared-value wiring (`heroTransX/Y/scale/rotZ/eye/wink`,
  `heroShowFace`) used by `onRefresh`.
- **Extracted vs in-feed sections**: `greeting_hero` and `header_promo` live in the
  `sections` array but are pulled out for pinned/header rendering — keep this
  extraction explicit and covered by `sanitizePage` so a missing/extra one is safe.
- **Migration numbering**: feature branch is behind `develop`; number new migrations
  after the current max and rebase before merge (watch for collisions). Backend
  migrations are forward-only; apply to local dev DB on port 5433.
- **Validator gate**: `make preflight` must pass; `validator.go` warns if no
  `hero_carousel` — confirm new types don't trip existing structural checks.

## Verification

- Per phase: `tsc --noEmit` clean; pull-to-refresh Home (light + dark) shows the
  block driven by config; toggling the block's config (e.g. omit `schedule_card`,
  flip `header_promo.visible`) changes the UI with no app rebuild.
- Backend: migration idempotent (re-run = no-op); `make preflight` green.
