# Authoring SDUI JSON (home & future pages)

How to write the JSON that drives a server-rendered screen. The home screen is
fully SDUI; this guide is the reference for editing it and for adding new pages.

**Source of truth (keep this guide in sync with these):**
- Wire types: `App/zopmop-app/src/sdui/types.ts`
- JSON schema (validated on stage): `App/househelp-api/schemas/sdui_page_config.json`
- Stage validation rules: `App/househelp-api/internal/bff/validator.go`
- Client action allowlist: `App/zopmop-app/src/sdui/allowlist.ts`
- Reference layout: `App/househelp-api/static/safe_layouts/home.json`
- Feed-vs-chrome split: `App/zopmop-app/src/screens/main/homeSections.ts`

---

## 1. Where it lives & how it ships

Edit configs in the **CRM → SDUI → Pages → `home`** (crm-api `/admin/pages/...`).

Lifecycle: **draft → staged → active**. Only one config is active per page.
- **New draft** → edit JSON (Monaco) → **Stage** (runs validation) → **Activate** (goes live).
- **Preview** renders the JSON in a phone frame before staging.
- **Rollback** / **Make live** re-ships a previous version.
- **Kill switch**: ON → clients get the static **safe layout** (`static/safe_layouts/home.json`), not your config. Turn OFF to restore the active config. Killed/fallback responses are `no-store` (never cached on device); the app refetches on focus and pull-to-refresh.

The app fetches `GET /api/v1/sdui/page/home`, caches by `config_hash` + ETag (304 = unchanged, keep current).

---

## 2. Page envelope

```json
{
  "page_id": "home",
  "version": "2026-06-08-promo",
  "min_client_version": "0.0.0",
  "sections": [ /* ordered list, see §3 */ ]
}
```

| Field | Required | Notes |
|---|---|---|
| `page_id` | ✅ | 1–64 chars. `home` for the home screen. |
| `version` | ✅ | 1–32 chars, free-text label (e.g. `4.2`, `diwali-promo`). Shown in CRM. |
| `min_client_version` | ✅ | strict semver `X.Y.Z` (use `0.0.0` for all). |
| `sections` | ✅ | array, **0–20 items** (>15 warns). Order = render order in the feed. |
| `experiment_id` | optional | string, for A/B. |
| `schema_version` | optional | integer ≥ 1. |

`config_hash`, `snapshot_at`, `config_version` are set by the server — don't author them.

---

## 3. Sections

Every section shares this base:

```json
{
  "id": "unique_within_page",
  "type": "<one of the 8 types>",
  "visible": true,
  "data": { /* type-specific, see §4 */ }
}
```

| Base field | Required | Notes |
|---|---|---|
| `id` | ✅ | 1–64 chars, unique. |
| `type` | ✅ | one of the 8 enum types (§4). Unknown type → section dropped (warns). |
| `visible` | ✅ | boolean. `false` hides it. |
| `data` | ✅ | object, shape depends on `type`. |
| `layout` | optional | whitelisted box props (§6). |
| `style` | optional | `bg`/`fg`/`radius` design tokens (§6). |
| `actions` | optional | array of actions (§5). |
| `rollout` | optional | `min_client_version` / `user_segment` / `percentage`. |
| `priority` | optional | `high`/`medium`/`low`. |
| `hydration`, `lazy_endpoint` | optional | for lazy-loaded sections. |

### Feed vs app-chrome (important)

Some section types are **extracted** out of the scrolling feed and rendered as
app chrome (header pill, hero, etc.) — see `homeSections.ts`:

- **Extracted (chrome):** `hero_carousel`, `greeting_hero`, `header_promo`, `upcoming_booking`, `live_pill`
  - `live_pill` rides inside the hero pager's first page (swipes with the hero).
- **Feed (scrolls, in `sections` order):** `usuals_row`, `service_grid`, `footer`

So the *order* in `sections` only controls the feed sections. Provide **exactly one
hero** (`greeting_hero` **or** `hero_carousel`) — the validator warns if neither
is present.

---

## 4. Section types & `data` shapes

### `greeting_hero` (static hero card)
```json
{ "id": "hero", "type": "greeting_hero", "visible": true,
  "data": { "greeting": "Good night, Aditya", "title_lines": ["Home,", "handled."], "show_mascot": true } }
```
- `title_lines`: each string is one line. `greeting` overrides the time-of-day kicker. `show_mascot`: the Zop peek + pull-to-refresh fly.

### `hero_carousel` (swipeable promo cards) — alternative to greeting_hero
```json
{ "id": "hero", "type": "hero_carousel", "visible": true,
  "data": {
    "greeting_name": "Aditya",
    "autoplay": true, "interval_ms": 4000, "loop": true, "restart_on_focus": false,
    "slides": [
      { "key": "s1", "eyebrow": "LIMITED", "title": "₹150 off", "body": "First deep clean",
        "cta": "Book now", "bg": "#0D0D0F", "accent": "#F5A300",
        "image_url": "https://...", "duration_ms": 5000,
        "action": { "trigger": "tap", "type": "navigate", "screen": "AllServices" } }
    ]
  } }
```
- `slides[]`: `key`, `eyebrow`, `title`, `body`, `cta`, `bg` (hex), `accent` (hex), `action` required; `image_url`, `duration_ms` optional. Page 0 is the greeting/hero; promo cards follow.
- Carousel-level `autoplay`/`interval_ms`/`loop`/`restart_on_focus` (defaults: true/4000/true/false). Hero card height >400 warns.

### `live_pill` (nearby stats, rides hero page 0)
```json
{ "id": "live", "type": "live_pill", "visible": true,
  "data": { "nearby_count": 0, "avg_eta_min": 0, "avg_rating": 0 } }
```
Numbers; the section starts "busy" and polls real availability — don't fake counts.

### `header_promo` (the "Earn ₹150" header pill)
```json
{ "id": "header_promo", "type": "header_promo", "visible": true,
  "data": { "label": "Earn ₹150", "amount_label": "₹150",
            "action": { "trigger": "tap", "type": "navigate", "screen": "ReferralEarn" }, "visible": true } }
```

### `upcoming_booking` (status pill toggle)
```json
{ "id": "upcoming_booking", "type": "upcoming_booking", "visible": true, "data": { "visible": true } }
```

### `usuals_row` (horizontal service shortcuts) — feed
### `service_grid` (titled service grid) — feed
```json
{ "id": "popular", "type": "service_grid", "visible": true,
  "data": {
    "title": "Popular services",
    "has_more": false,
    "services": [
      { "id": "a1000000-0000-0000-0000-000000000002", "name": "Bathroom cleaning",
        "emoji": "🚿", "bg_color": "#F0FDFA",
        "base_price_cents": 29900, "mrp_cents": 59900,
        "rating": 4.9, "review_count": 17800,
        "min_duration_minutes": 30, "max_duration_minutes": 90, "duration_step_minutes": 15,
        "is_active": true, "display_order": 1 }
    ]
  } }
```
- `services[]` is the `ApiService` shape. `usuals_row.data` is just `{ "services": [...] }`.
- **Money is integer paise** in `base_price_cents` / `mrp_cents` (no floats; `29900` = ₹299.00).
- **`id` must be a real service UUID** — the 3D icon resolves by `id` first, so a wrong/placeholder id shows the wrong icon. (`emoji` is a fallback.)

### `footer` (signoff + optional trust/schedule) — feed
```json
{ "id": "footer", "type": "footer", "visible": true,
  "data": {
    "signoff": { "lines": ["We mop.", "You zop."], "brand": "ZopMop",
                 "badges": ["Vetted pros", "30-min support"], "tagline": "Built in India" },
    "schedule_card": null,
    "trust": null
  } }
```
- `signoff` required. `schedule_card` and `trust` are optional/nullable — omit or `null` to hide (don't fabricate trust numbers).

---

## 5. Actions

Discriminated by `type`; every action needs a `trigger` (`tap`/`long_press`/`auto`).

```json
{ "trigger": "tap", "type": "navigate", "screen": "AllServices", "params": {} }
{ "trigger": "tap", "type": "deep_link", "url": "https://zopmop.com/offers" }
{ "trigger": "tap", "type": "toast", "message": "Saved", "variant": "success" }
{ "trigger": "tap", "type": "bottom_sheet", "sheet_id": "filters", "props": {} }
{ "trigger": "tap", "type": "api_call", "endpoint": "/api/v1/sdui/...", "method": "POST", "body": {} }
{ "trigger": "auto", "type": "load_more", "section_id": "popular", "cursor": "abc", "endpoint": "/api/v1/sdui/..." }
```

**Allowlist (enforced — `allowlist.ts` on the client, `validator.go` on stage):**
- `navigate.screen` must be in `ALLOWED_SCREENS` (mirror of `MainNavigator.tsx`). Unknown screen → action silently dropped on device. Add the screen to both places when you add a route.
- `deep_link.url` must be **https** only (no `tel:`/`upi:`/custom schemes).
- `api_call` / `load_more` endpoints must start with **`/api/v1/sdui/`**, methods `POST`/`DELETE` only. Unknown endpoint or disallowed method → **stage fails**. The endpoint must also be registered in the CRM **Action allowlist**.

---

## 6. Layout & style (whitelisted)

Servers can't send arbitrary styles — only these:

`layout`: `height`, `width` (number or `"100%"`), `flex`, `flexDirection`, `alignItems`, `justifyContent`, `gap`, `zIndex`, `marginTop/Bottom/Horizontal`, `paddingHorizontal/Vertical`, `borderRadius`, `overflow`.

`style`: `bg`/`fg` ∈ `brand-primary`, `brand-secondary`, `surface`, `surface-alt`, `text-primary`, `text-muted`, `border`; `radius` ∈ `sm`/`md`/`lg`/`full`.

Anything outside the whitelist is rejected by the schema (`additionalProperties:false` on layout/style).

---

## 7. What the stage validator checks

Staging runs `validator.go` — fix **errors** (block), review **warnings** (don't block):

- Size cap (`config exceeds N bytes`) and non-empty.
- JSON Schema (`sdui_page_config.json`): required fields, enums, semver, ≤20 sections.
- Section count >15 → warn; >20 → error.
- `$include` count ≤ 5; cyclic/duplicate include → error.
- No hero (`hero_carousel`/`greeting_hero`) → warn.
- Unknown `section.type` → warn (section won't render).
- `hero_carousel` height >400 → warn.
- Action allowlist (endpoints/methods) → error on violation.

---

## 8. Gotchas (learned the hard way)

- **No native-only components.** SDUI sections must use core RN only — a native module missing from the binary crashes (Fabric SIGABRT, uncatchable). The hero carousel is a core `ScrollView`, not a native pager.
- **Service icons** resolve by `id` (UUID) first → use real service UUIDs in `usuals_row`/`service_grid`, or the wrong 3D icon shows.
- **Money** = integer paise in `*_cents` fields. Never floats.
- **One hero only.** Use `greeting_hero` *or* `hero_carousel`.
- **Don't author** `config_hash`/`snapshot_at`/`config_version` — server-set.
- **Free-text `version`** is fine (`"diwali promo?"`), but it's URL-encoded in admin calls — already handled (FE encodes, crm-api `UnescapePath`).
- After changing the `SduiSection` shape in `types.ts`, bump `CACHE_SCHEMA_VERSION` in `useSduiPage.ts` (drops stale device caches).

---

## 9. Minimal valid page

```json
{
  "page_id": "home",
  "version": "minimal-example",
  "min_client_version": "0.0.0",
  "sections": [
    { "id": "hero", "type": "greeting_hero", "visible": true,
      "data": { "title_lines": ["Home,", "handled."], "show_mascot": true } },
    { "id": "footer", "type": "footer", "visible": true,
      "data": { "signoff": { "lines": ["We mop.", "You zop."], "brand": "ZopMop", "badges": [], "tagline": "" } } }
  ]
}
```

For a complete, working reference see `App/househelp-api/static/safe_layouts/home.json`.
