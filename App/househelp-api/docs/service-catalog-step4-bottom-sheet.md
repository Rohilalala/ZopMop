# Service Catalog Rework — Step 4 of 4: Service Detail Bottom Sheet

**Branch:** `feature/appearance-and-location-toast`
**Date:** 2026-06-07 (Asia/Kolkata)
**Commits:** `4cc136e` (4a backend) + this (4b front-end)

Final step: replace the full-screen `ServiceAboutScreen` with a bottom sheet that rises over the dimmed catalog, reading the content seeded in Steps 1-3.

---

## Stage 0 — API shape finding (backend gap → fixed in 4a)

`GET /services/:id/details` originally returned `{ service, includes, excludes, steps }` — **no FAQ data**. `service_faqs` (created in Step 2) had zero consumers, and global `faq_items` were only on a separate `/app/faqs` route. Per the front-end-only rule I stopped and reported this; you chose **"backend step first."**

**Step 4a (commit `4cc136e`, Go):** `ServiceDetails` now includes `faqs[]` — the server-resolved union of global `faq_items` + per-service `service_faqs`, with per-service entries suppressing any global FAQ of the same question. This puts the **Pre and Post Party Clean price-FAQ override** (fixed 90-minute) resolution server-side, so the client never shows two contradictory price answers.

Verified on a dev-DB clone: Bathroom → pro-safety / price / supplies; Pre+Post Party → pro-safety / supplies / price-override (global price suppressed, exactly one price FAQ).

---

## Step 4b — the sheet (front-end)

### Files
- `components/ui/BottomSheet.tsx` — **backward-compatible** enhancement: optional `expandedHeight` (two-snap peek↔expanded), `header` (handle-only drag so the body scrolls), `footer` (sticky CTA pinned across snaps). With none of these props it behaves exactly as before — `WalletTopupSheet` is unaffected.
- `screens/main/ServiceAboutScreen.tsx` — rewritten as the sheet (reuses the existing `base*dur/min` price formula, `useC()/useTheme()` theming, cart, and the includes/excludes/steps styling).
- `navigation/MainNavigator.tsx` — `ServiceAbout` route → `presentation: 'transparentModal'` + transparent `contentStyle` so the catalog stays visible (dimmed) behind the sheet. All 3 `navigate('ServiceAbout', {service})` call sites unchanged.
- `api/services.ts` — `ServiceFaq` type + `faqs` on `ServiceDetails` (mirrors 4a).
- `assets/icons/1.png`–`4.png` — the step numerals (added; `1.png` was the Step-3 gap, now supplied).

### Render rules honored
- **Duration:** built from `min/max/step` → 30/60/90 segmented selector. `step<=0 || max<=min` (Pre/Post Party 90/90/0) → single **fixed-90** block, no toggle.
- **Live price:** `Math.round(base_price_paise * duration / min_duration_minutes)` — unchanged formula, integer paise; updates on duration change and feeds the sticky add bar.
- **FAQs:** rendered from `details.faqs` (the 4a union; suppression already applied server-side).
- **Step numerals:** `service_steps.icon` (`step-1`..`step-4`) → `1.png`..`4.png` via a static map; falls back to a numbered circle if absent.
- **Section gating:** includes / excludes / steps / faqs each render only when non-empty.
- **Duration-logic guidance:** per-service client copy (deferred from Step 2) shown under the selector, keyed by service id; Party shows the fixed-slot line.
- **No add-on block** (removed per the adjustment); **no "Car Surface Cleaning"** — all content is live data.
- **Two themes** via `useC()/useTheme()`; amber `#F5A300` accent, dark glass / light cream tokens.

### Sheet mechanics
Peek (`~56%`) shows hero diorama + title + hook + rating + duration + price + "View full details"; the sticky add bar is pinned across snaps. Expand (`~92%`, via the button or drag-up) reveals includes/excludes/steps/faqs. Drag-down past peek (or tap the dim backdrop / close button) closes → `navigation.goBack()`.

---

## Verification

| Check | Result |
|---|---|
| `tsc --noEmit` (whole app) | ✅ rc=0 |
| `BottomSheet` enhancement backward-compatible (WalletTopupSheet uses old props only) | ✅ |
| All 3 `ServiceAbout` entry points (AllServices, UsualsRow, ServiceGrid) unchanged | ✅ |
| FAQ union + Pre/Post Party price suppression (server-side, 4a) | ✅ (dev-DB clone) |
| Numeral assets `1.png`–`4.png` present and wired | ✅ |
| No migration/schema touched; Go change is the isolated, reviewed 4a | ✅ |
| Deactivated services unreachable (catalog lists active only) | ✅ (existing List behavior) |

### Not self-verifiable here (needs a sim/device pass)
Runtime visuals, gesture feel (two-snap drag, scroll-vs-pan), and both-theme rendering require running the app — I can't interactively drive that in this environment, and the Step-4 rules forbid mutating the dev DB (which is still at migration 111, so the seeded content from Steps 1-3 won't appear until 112-115 are applied to whatever DB the app reads). Recommend a sim pass after the branch's migrations are applied to a local DB: open several services (incl. Pre/Post Party for the fixed-90 + price-override), toggle durations, expand, and check dark/light.

## Notes
- Migration numbering unchanged (no new migration in Step 4). The branch's pre-`779e628` dup-`109` is still the documented pre-merge rebase item.
