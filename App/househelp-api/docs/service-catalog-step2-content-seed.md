# Service Catalog Rework — Step 2 of 4: Content Seed

**Branch:** `feature/appearance-and-location-toast` · **Migrations:** `113_create_service_faqs`, `114_seed_service_catalog_content`
**Date:** 2026-06-07 (Asia/Kolkata) · **Scope:** seed data (+ one approved additive table). No Go, no front-end, no icons.

Seeds per-service content for the 17 active services from the locked content reference, **verbatim**.
Pricing/duration columns from Step 1 are untouched (`114.up` has 0 pricing/duration references).

---

## Schema inventory + section → table mapping

| Content section | Destination | Notes |
|---|---|---|
| Hook | `service_categories.short_description` (varchar 255) | was NULL on all rows |
| Description | `service_categories.description` (text) | was NULL on all rows |
| Includes (ordered) | `service_includes(item, display_order)` | from migration 011 |
| Does-not-include (ordered) | `service_excludes(item, display_order)` | from migration 011 |
| How-its-done steps | `service_steps(step_number, title, description)` | split on " — "; `icon` left NULL (Step 3) |
| Global FAQ 1 (pro-safety) + FAQ 3 (price) | `faq_items` (shared, seeded once) | `faq_items` has no `service_id` |
| Per-service supplies FAQ | **`service_faqs`** (NEW table, 113) | one per service |
| Pre/Post price override | `service_faqs` (extra row on Pre and Post Party Clean) | overrides global price FAQ for that service |
| Duration-logic text | not seeded | deferred to Step 4 UI (per decision) |

### FAQ placement decision
`faq_items` (006) is global (no `service_id`). Decision: **new `service_faqs` table** (`id, service_id FK CASCADE, question, answer, display_order, UNIQUE(service_id, display_order)`), mirroring the existing per-service content tables (`service_includes/excludes/steps`). Global FAQs (pro-safety, price) stay in `faq_items`; per-service supplies + the party price override live in `service_faqs`. This is the only schema change in Step 2 and was approved before seeding (`faq_items` schema untouched).

Other decisions: Laundry seeded **verbatim** (the air-dry "build note" is not locked copy, not added). Supplies FAQ question text (absent from the doc) seeded as **"Do I need to provide any supplies?"** (approved), shared across all 17, answer varies.

### Name → id map (from Step 1 migration 112; all `a1000000-0000-0000-0000-0000000000NN`)
`002` Bathroom Cleaning · `003` Utensil Washing · `001` Sweeping and Mopping · `004` Dusting · `019` Packing · `020` Unpacking · `009` Ironing and Folding · `006` Laundry · `005` Kitchen Prep · `007` Window Cleaning · `012` Kitchen Cleaning · `010` Balcony Cleaning · `021` Fan Cleaning · `008` Fridge Cleaning · `014` Wardrobe Organization · `018` Plant Care · `022` Pre and Post Party Clean

---

## Verification (local scratch clone of dev DB; dev DB only read; scratch dropped after)

Flow: clone `househelp_db` → apply `112` (Step 1) → `113` → `114` → assert → `114` down/up → `113` drop/recreate.

| Check | Result |
|---|---|
| `112`/`113`/`114` apply clean (`ON_ERROR_STOP=1`, in sequence after 112) | ✅ |
| Totals — includes / excludes / steps / service_faqs / faq_items | ✅ **87 / 81 / 68 / 18 / 2** |
| All 17 active have description + short_description + ≥1 include + ≥1 exclude + ≥1 step + supplies FAQ | ✅ |
| Pre/Post Party price override present (`service_faqs`, fixed 90-min answer) | ✅ |
| 2 global FAQs exist once each in `faq_items` | ✅ |
| No content attached to the 5 deactivated services | ✅ |
| Verbatim spot-checks (description, `arm's reach` apostrophe, step, party answers) | ✅ |
| Blank-string guard (empty item/title/description rows) | ✅ 0 |
| `114` down → content tables empty + descriptions NULL | ✅ |
| `114` up → down → up round-trips (back to 87/81/68/18/2) | ✅ |
| `113` down drops `service_faqs`; up recreates; reseed = 18 | ✅ |
| Cart pricing golden test | ✅ `ok` |
| No Go files modified; no pricing/duration columns touched | ✅ |

### Per-service completeness
| # | Service | desc | short | inc | exc | steps | supplies |
|---|---|---|---|---|---|---|---|
| 1 | Bathroom Cleaning | Y | Y | 6 | 4 | 4 | 1 |
| 2 | Utensil Washing | Y | Y | 5 | 4 | 4 | 1 |
| 3 | Sweeping and Mopping | Y | Y | 5 | 5 | 4 | 1 |
| 4 | Dusting | Y | Y | 5 | 5 | 4 | 1 |
| 5 | Packing | Y | Y | 5 | 4 | 4 | 1 |
| 6 | Unpacking | Y | Y | 5 | 5 | 4 | 1 |
| 7 | Ironing and Folding | Y | Y | 5 | 5 | 4 | 1 |
| 8 | Laundry | Y | Y | 5 | 5 | 4 | 1 |
| 9 | Kitchen Prep | Y | Y | 5 | 5 | 4 | 1 |
| 10 | Window Cleaning | Y | Y | 5 | 5 | 4 | 1 |
| 11 | Kitchen Cleaning | Y | Y | 5 | 5 | 4 | 1 |
| 12 | Balcony Cleaning | Y | Y | 5 | 5 | 4 | 1 |
| 13 | Fan Cleaning | Y | Y | 5 | 5 | 4 | 1 |
| 14 | Fridge Cleaning | Y | Y | 5 | 5 | 4 | 1 |
| 15 | Wardrobe Organization | Y | Y | 5 | 5 | 4 | 1 |
| 16 | Plant Care | Y | Y | 5 | 5 | 4 | 1 |
| 17 | Pre and Post Party Clean | Y | Y | 6 | 4 | 4 | 1 (+1 price override) |

---

## Notes for Step 4 (front-end)
- Per service, the FAQ section = global `faq_items` (pro-safety, price) + the service's `service_faqs` rows. For Pre and Post Party Clean, suppress the global price FAQ and show its `service_faqs` price-override instead.
- Duration-logic copy was intentionally not seeded; surface it in the UI.
- `service_steps.icon` is NULL (Step 3 will populate icons).

## Migration numbering
`113`/`114` follow Step 1's `112` on this branch and clear develop/main's max (`111`). The branch's pre-`779e628` dup-`109` is unchanged (per the earlier decision: merges fine; rebase onto develop only if desired).
