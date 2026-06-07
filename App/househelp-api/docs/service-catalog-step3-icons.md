# Service Catalog Rework — Step 3 of 4: Icon Wiring

**Branch:** `feature/appearance-and-location-toast`
**Date:** 2026-06-07 (Asia/Kolkata) · **Scope:** icon assets + `serviceIcon.ts` + one data migration. No Go logic, no UI (Step 4).

Two jobs: (A) wire the 17 service catalog icons in `serviceIcon.ts`; (B) populate `service_steps.icon` with numeral keys.

---

## Job A — Service catalog icons

### Filename rename table (old → new)
All renamed files were **untracked** new additions, so `git mv` was not applicable (no history to preserve); plain `mv` + `git add`. Already-clean tracked files were left as-is.

| Old on-disk name | New name | Note |
|---|---|---|
| `dusting and wiping.png` | `dusting.png` | spaces; service is now "Dusting" |
| `fan cleaning.png` | `fan-cleaning.png` | space |
| `fridge cleaning.png` | `fridge-cleaning.png` | space |
| `kitchen clening.png` | `kitchen-cleaning.png` | typo + space |
| `wardrobe organisation.png` | `wardrobe-organization.png` | space + British spelling |
| `pre:post party .png` | `pre-post-party.png` | the "slash" is a **colon** on disk; trailing space |
| `plantcare.png` | `plant-care.png` | restores the previously-deleted tracked path |
| `Ironing .tiff` | `ironing-and-folding.png` | **was TIFF**, converted to PNG via `sips` (PNG is the required RN format) |

Already clean, untouched: `balcony.png`, `bathroom-cleaning.png`, `kitchen-prep.png`, `laundry.png`, `mopping-and-sweeping.png`, `packing.png`, `unpacking.png`, `utensils.png`, `window-cleaning.png`.
Orphan: `car-cleaning.png` — Car Cleaning was deactivated in migration 112; file left on disk, **not mapped**.

All 18 files validated as PNG (`file` + `sips`).

### serviceIcon.ts — how resolution works
`serviceIcon({ id, name })` resolves in order: (1) `ID_TO_KEY[id]` → `ASSETS[key]` (primary path; the screens always pass the service id), else (2) `slug(name)` → `ASSETS` or `NAME_ALIASES`. Returns `undefined` → caller falls back to the emoji glyph.

Changes:
- **`ASSETS`**: 8 → 18 keys (added `dusting, packing, unpacking, ironing-and-folding, laundry, kitchen-cleaning, fan-cleaning, fridge-cleaning, wardrobe-organization, pre-post-party`; `car-cleaning` kept but unmapped).
- **`ID_TO_KEY`**: 5 → **17** (every active service id from the Step 2 name→id map; filled the old 0004/0006 gaps).
- **`NAME_ALIASES`**: +3 where the name-slug differs from the asset key (`utensil-washing→utensils`, `balcony-cleaning→balcony`, `pre-and-post-party-clean→pre-post-party`).

Verification: all 18 `require()` targets exist on disk; all 17 `ID_TO_KEY` values exist in `ASSETS`; `tsc --noEmit` passes (rc=0); no unrelated files touched.

### Image-size recommendation (report only — not resized here)
Sources are large: 1024×1024 to 1536×1024 (some 1254²); the folder is ~25 MB. They render small — detail hero `52×52`, addon `38×38`, catalog card in the same small range. That is roughly a 20–30× oversample across 17+ icons, which inflates bundle size and decode/memory.

**Recommendation (Step 3.5 or Step 4):** downscale the source PNGs to a ~**256 px** baseline (covers the largest ~85 px display at @3x with headroom), or ship `@2x`/`@3x` variants. Estimated ~25 MB → ~1–2 MB. **Keep PNG** (full-color dioramas with alpha — do not convert to ico/icns/SVG). Not auto-resized in this step to avoid silently altering the art.

---

## Job B — How-its-done step numerals

`service_steps.icon` (varchar(10)) was NULL after Step 2 and has **no consumer yet** (the current full-screen page renders `step_number` as text; the bottom-sheet in Step 4 will consume the icon). Convention chosen: **`step-1`..`step-4`** (self-describing key; Step 4 maps it to `assets/icons/1.png`..`4.png`).

Migration **`115_set_service_step_icons`**: `UPDATE service_steps SET icon = 'step-' || step_number;` (idempotent). Disclaimer-headed down reverts `WHERE icon LIKE 'step-%'` to NULL.

> ⚠️ **Asset gap for Step 4:** `assets/icons/` currently has `2.png, 3.png, 4.png` but **`1.png` is missing**. The migration stores keys regardless, but Step 4 needs `1.png` added to render step 1.

---

## Verification

| Check | Result |
|---|---|
| **A** All renamed files are valid PNG (18) | ✅ |
| **A** Every `require()` target exists on disk | ✅ 18/18 |
| **A** Every active service id resolves to a present asset (17) | ✅ |
| **A** `tsc --noEmit` | ✅ rc=0 |
| **B** 112→113→114→115 apply clean (in sequence) | ✅ |
| **B** All 68 step rows `icon = 'step-' || step_number` (values `step-1..step-4`) | ✅ 68/68 |
| **B** `115` down → all 68 NULL; up→down→up round-trips | ✅ |
| Cart pricing golden test | ✅ `ok` |
| No Go files modified | ✅ |

Verified on a scratch clone of the dev DB (dev DB only read; scratch dropped after).

## Notes
- Migration numbering: `115` follows Step 2's `113/114` on this branch (develop/main max is `111`).
- Missing `1.png` and the diorama downscale are the two follow-ups before/within Step 4.
