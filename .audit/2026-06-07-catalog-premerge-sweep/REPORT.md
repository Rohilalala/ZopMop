# ZopMop Catalog Rework — Pre-Merge Read-Only Sweep

**Date:** 2026-06-07 (Asia/Kolkata)
**Branch:** `feature/appearance-and-location-toast` (UNMERGED)
**Commit range:** `95cb605..92f138c` (112 reconcile · 113/114 content · 115 icons · 4a Go faqs · 4b RN sheet)
**Mode:** READ-ONLY — findings only, no fixes, no DB mutation.

> **How this report was produced:** synthesized from 6 read-only audit agents (areas 1-6) plus an independent reviewer. The file was authored to disk by the orchestrator because the in-workflow subagent `Write` was blocked by a harness guard ("subagents return findings as text, not write report files"). Companion `REVIEW.md` (independent first-principles sweep + 30-citation verification table) sits beside this file. All citations below are `file:line` from the cited source; money in paise; times Asia/Kolkata.

---

## Merge decision

### A. MUST resolve before merging to develop
1. **[BLOCKER] Duplicate migration version `109`** — `migrations/109_cap_promo_discount_value.up.sql:1` and `migrations/109_payroll_admin_audit.up.sql:1` both exist on this branch (no `111_*`; 110→112 gap). The runner uses golang-migrate `source/file` (`cmd/migrate/main.go:27-29`), which rejects duplicate versions → `migrate up` fails **before** 112-115 apply. Catalog content never reaches any DB; deploy fails at the migrate step. Fix = rebase onto develop (which renumbered via `779e628`) to inherit the de-dup, then `make preflight`. *(Pre-existing from merged PRs; blocks this merge regardless.)*
2. **[BLOCKER] Four active services priced at the ₹1 placeholder are fully bookable** — migration 112 seeds Packing/Unpacking/Fan Cleaning/Pre+Post Party (`…019/020/021/022`) with `base_price_cents=100` (₹1), `mrp_cents=100`, `is_active=true` (`migrations/112_reconcile_service_catalog_17.up.sql:42-51`). They appear in the catalog (`internal/services/repository.go:23-33`, `List` filters `is_active=true`). The **server is authoritative and re-derives ₹1** with no floor: cart ignores the client price and calls `GetServicePrice` (`internal/cart/service.go:45`), which is `base*dur/min` with only a `min<=0→30` guard (`internal/cart/repository.go:169-190`); booking sums the ₹1 line + base fee (`internal/booking/service.go:403-426`, `:764`). No client floor either (`ServiceAboutScreen.tsx:88-93`). → a customer can book these for ₹1-₹3 + base fee. Fix = set real prices, OR `is_active=false` until priced, OR add a price floor.

### B. Can ship now, fix later
- [SHOULD-FIX] SDUI home (migration 036) serves the **stale pre-112 catalog** (old names/prices/step=15) as literals; the hydrator only resolves `$ref` and 036 has none — `migrations/036_seed_sdui_home.up.sql:154`, `sdui/sections/ServiceGridSection.tsx:150`.
- [SHOULD-FIX] SDUI 036 JSON uses `base_price_cents` but RN reads `base_price_paise` → ₹NaN/₹0 + undefined add-to-cart price — `migrations/036_seed_sdui_home.up.sql:57`, `ServiceGridSection.tsx:150`.
- [SHOULD-FIX] Sheet strikethrough MRP not duration-scaled while live price is → discount **inverts** at 60/90 min — `screens/main/ServiceAboutScreen.tsx:206`.
- [SHOULD-FIX] Cart-based scheduled booking does not re-validate `is_active`; a deactivated service in a stale cart still books — `internal/booking/service.go:767`.
- [SHOULD-FIX] `/details` endpoint has no `is_active` filter — serves detail for deactivated services — `internal/services/repository.go:191`.
- [SHOULD-FIX] Migration 115 `UPDATE` is **unscoped** — rewrites `icon` for ALL `service_steps` incl. the 5 deactivated services — `migrations/115_set_service_step_icons.up.sql:11`.
- [SHOULD-FIX] Dioramas oversampled ~3-9× (render at 38-56 px, sources 1024-1536 px; folder **21 MB**, incl. a 1.5 MB `car-cleaning.png` for a deactivated service) — `components/home/serviceIcon.ts:30`.
- [SHOULD-FIX] Sheet has no exit animation + nested `Modal`-in-`transparentModal` + header-only pan → needs a sim/Android pass — `components/ui/BottomSheet.tsx:74,160`, `navigation/MainNavigator.tsx:106`.
- [BACKLOG] Client-side `DURATION_GUIDANCE` hardcoded by UUID (drift vs seeded copy) — `ServiceAboutScreen.tsx:56`.
- [BACKLOG] `detailsCache` never invalidated — `ServiceAboutScreen.tsx:101`.
- [BACKLOG] CRM/pro stale hardcoded service lists — `WorkerNewPage.tsx:37`, `ProOnboardingScreen.tsx:38`.
- [BACKLOG] FIXED-90 service shows a dead `-` stepper on the AllServices card — `AllServicesScreen.tsx:647`.
- [BACKLOG] Orphaned `audit_diff.md` reference in both golden test headers (file does not exist) — `cart_pricing_golden_test.go:10`, `service_pricing_golden_test.go:7`.
- [BACKLOG] No golden/regression test covers the placeholder services (₹1 exposure invisible to CI).
- [INFO] `.down.sql` files added vs forward-only policy — **down-ranked**: they self-document "tooling completeness only" and the runner calls only `m.Up()` (`cmd/migrate/main.go:8`, `migrations/112_reconcile_service_catalog_17.down.sql:1`). Consistency nit, not a blocker.

---

## Section 1 — Fallbacks and defaults
- **[BLOCKER]** ₹1 placeholder services bookable end-to-end, no price floor (client or server). See Merge-decision A2. `112_…up.sql:42-51`, `cart/service.go:45`, `cart/repository.go:169-190`, `booking/service.go:403-426,764`, `ServiceAboutScreen.tsx:88-93`.
- **[FYI]** `serviceIcon()` returns `undefined` when no id/name key → caller falls back to the emoji glyph; callers handle it (`components/home/serviceIcon.ts:49-63`, `ServiceAboutScreen.tsx` hero).
- **[FYI]** Content sections + `faqs[]` gate on `.length>0` — a service missing a section hides it cleanly (`ServiceAboutScreen.tsx:303,329,370`).
- **[FYI / SAFE]** `buildDurations()` guards `step<=0 || max<=min → [min]` → fixed-90 (90/90/0) yields a single block, no loop/divide-by-zero (`ServiceAboutScreen.tsx:76-86`).
- **[BACKLOG]** `detailsCache` never invalidated; an admin price/content change won't refresh a cached open (`ServiceAboutScreen.tsx:101`).

## Section 2 — Compromises made for expedience
- **[BLOCKER]** dup-109 migration ancestry — see Merge-decision A1 (`109_cap_promo_discount_value.up.sql:1`, `109_payroll_admin_audit.up.sql:1`, `cmd/migrate/main.go:27-29`).
- **[FYI / VERIFIED OK]** TIFF→PNG ironing conversion did NOT degrade: `ironing-and-folding.png` re-read = PNG, 1024×1024, 8-bit **RGBA, hasAlpha=yes**, 4 samples/px — alpha + depth intact, not flattened.
- **[SHOULD-FIX]** Dioramas oversampled, 21 MB folder incl. deactivated `car-cleaning.png` — `serviceIcon.ts:30`.
- **[BACKLOG]** Duration-logic guidance client-side static, drift risk vs seed — `ServiceAboutScreen.tsx:56`.
- **[SHOULD-FIX]** Migration 115 unscoped UPDATE — `115_…up.sql:11`.
- **[INFO]** `.down.sql` vs forward-only policy — down-ranked (see Merge-decision B).

## Section 3 — Surfaced-but-not-acted-on (decision verification)
All four deferred decisions were **implemented as decided**:
- **[FYI ✓]** Per-service FAQ home = NEW `service_faqs` table; `faq_items` NOT altered (`113_create_service_faqs.up.sql:13-20`; `faq_items` unchanged at `006_create_banners.up.sql:35-41`).
- **[FYI ✓]** Laundry air-dry caveat **omitted** from the 114 Laundry seed (verbatim, as decided).
- **[FYI ✓]** Pre/Post Party price-FAQ override handled **server-side**: override row `114_…up.sql:387-388` (display_order 2, "How is the price worked out?") + suppression in `repository.go:228-288`.
- **[FYI ✓]** Duration-logic text **deferred to UI** (client static), not seeded into the DB.
- **[FYI ✓]** Supplies-FAQ question ("Do I need to provide any supplies?") seeded consistently across all 17.

## Section 4 — Pre-existing issues touched / new exposure
- **[FYI / pre-existing, UNTOUCHED]** The three downstream bugs from the prior service-catalog audit (labeled B-A/B-B/B-C there; those labels are not in-repo) are confirmed **not touched, not worsened**: dispatch shift-gate wrong column (`internal/matching/dispatch.go:216`), `job_minutes` never written, cancellation penalty reads a non-existent column → always 60 (`internal/shift/repository.go:724`).
- **[SHOULD-FIX]** SDUI home 036 stale catalog + `base_price_cents`/`base_price_paise` mismatch — `036_…up.sql:57,154`, `ServiceGridSection.tsx:150`.
- **[SHOULD-FIX]** Cart scheduled booking + `/details` lack `is_active` re-check — `booking/service.go:767`, `services/repository.go:191`.
- **[BACKLOG]** Stale hardcoded lists in CRM/pro onboarding — `WorkerNewPage.tsx:37`, `ProOnboardingScreen.tsx:38`.
- **[FYI / SAFE]** Fixed-90 `step=0` handled everywhere; price divides by `min_duration` (with `min<=0→30` guard), never by `duration_step_minutes` (`cart/repository.go:186-189`, `ServiceAboutScreen.tsx:92`). Old `computeNextDuration/computePrevDuration` removed in the 4b rewrite.
- **[FYI]** No remaining live reference to the dead v2 variant/bundle schema (084/085/086) or the old utensil per-item path.

## Section 5 — Consistency between layers
- **[FYI ✓]** Go↔RN `faqs` shape matches field-for-field: `ServiceFaq{question,answer,display_order}` + `ServiceDetails.faqs` (`model.go:53-57`, `api/services.ts:52-64`); DB columns match (`113_…up.sql:13-20`, `006_…:35-41`); query reads them (`repository.go:234,259`).
- **[FYI ✓]** 17 active ids ↔ `serviceIcon.ts` `ID_TO_KEY`/`ASSETS` ↔ seeded content all aligned; `car-cleaning` present in `ASSETS` but unmapped (deactivated) — expected.
- **[FYI ✓]** Step keys `step-1..step-4` ↔ RN `NUMERAL_PNG` ↔ `1.png..4.png` all match (`115_…up.sql:11`, `ServiceAboutScreen.tsx:47-52`).
- **[BACKLOG]** `faqs[].display_order` is decorative — final order is "globals then per-service," not sorted by the field (`repository.go:283`).
- **[BACKLOG]** `serviceIcon.ts` `NAME_ALIASES` unguarded (`serviceIcon.ts:65`).
- **[BACKLOG]** Orphaned `audit_diff.md` ref in golden test headers — `cart_pricing_golden_test.go:10`, `service_pricing_golden_test.go:7`.

## Section 6 — Anything else risky or surprising
- **[SHOULD-FIX]** Sheet: no exit animation; nested `Modal` inside `transparentModal` route; header-only pan vs inner ScrollView — needs a sim/Android pass (`BottomSheet.tsx:74,160`, `MainNavigator.tsx:106`).
- **[SHOULD-FIX]** Strikethrough MRP not duration-scaled → discount inverts at 60/90 (`ServiceAboutScreen.tsx:206`).
- **[FYI]** New services `mrp_cents = base = ₹1` → "₹1 struck-through ₹1" display oddity once visible (`112_…up.sql:42-51`).
- **[BACKLOG]** Sheet controls have no accessibility labels (`ServiceAboutScreen.tsx:188`).
- **[INFO / process]** Dev DB was at migration 111 during the build; no sim/device pass done — runtime visuals/gesture/themes unverified (`docs/service-catalog-step4-bottom-sheet.md:57-58`). The running native `go run ./cmd/api` predated commit `4cc136e`, so it must be restarted to serve `faqs[]`.
- **[FYI ✓]** `BottomSheet` enhancement is backward-compatible — `WalletTopupSheet` uses only the original props.

---

## Severity tally
Distinct issues after cross-area dedup: **BLOCKER 2 · SHOULD-FIX 8 · BACKLOG 8 · INFO/FYI ~26** (mostly positive confirmations). Raw per-area finding counts (with duplicates): area1=9, area2=6, area3=6, area4=11, area5=8, area6=14.

**Bottom line: DO NOT MERGE as-is.** Resolve the two blockers first — de-duplicate migration 109 (rebase onto develop), and resolve the ₹1 placeholder on the four active services (real price / deactivate / floor). Everything else is shippable-then-fix. The fixed-90 path and the Go↔RN faqs contract are correct. See `REVIEW.md` for the independent verification table.
