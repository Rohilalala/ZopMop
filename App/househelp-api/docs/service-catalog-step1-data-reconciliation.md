# Service Catalog Rework — Step 1 of 4: Data Layer Reconciliation

**Branch:** `feature/appearance-and-location-toast` · **Migration:** `112_reconcile_service_catalog_17`
**Date:** 2026-06-07 (Asia/Kolkata) · **Scope:** migrations + seed data only (no Go, no front-end, no content/icons)

Reconciles `service_categories` to the final **17-service** catalog on the **30/60/90-minute** time-tiered model
(`min=30, max=90, step=30`), with **Pre and Post Party Clean** fixed at 90 (`min=90, max=90, step=0`).
Existing rows keep their ids (FK history preserved). Off-list services are deactivated (`is_active=false`), never deleted.

---

## Migration numbering note (read before merge)

This feature branch carries the **old, un-renumbered** migration set: a **duplicate `109_*`**
(`109_cap_promo_discount_value`, `109_payroll_admin_audit`) and no `111_*`. `develop`/`main` already fixed this
via commit `779e628` (renumbered → `110_payroll_admin_audit`, `111_helper_flags_and_dispatched_accept_cancel`),
so their canonical max is **111**, and the local dev DB is at `schema_migrations.version = 111`.

→ This migration is numbered **112** so it does not collide with `develop`/`main`'s `111`.
**Pre-existing issue (not addressed here):** before merge, rebase this branch onto `develop` to inherit `779e628`;
the duplicate `109` will otherwise collide. `112` is safe regardless of how that is resolved.

---

## Bucket mapping

13 existing rows kept/renamed + 4 new = **17 active**; 5 deactivated; **22 rows total**.

### KEEP+ALIGN (9) — id kept; durations→30/90/30 + display_order set; name/price untouched
| New order | Service | id suffix | Change |
|---|---|---|---|
| 1  | Bathroom Cleaning      | …002 | step 15→30; order 2→1 |
| 8  | Laundry                | …006 | step 15→30; order 6→8 |
| 9  | Kitchen Prep           | …005 | step 15→30; order 5→9 |
| 10 | Window Cleaning        | …007 | step 15→30; order 7→10 |
| 11 | Kitchen Cleaning       | …012 | step 15→30; order 12→11 |
| 12 | Balcony Cleaning       | …010 | step 15→30; order 10→12 |
| 14 | Fridge Cleaning        | …008 | step 15→30; order 8→14 (price ₹149 kept) |
| 15 | Wardrobe Organization  | …014 | step 15→30; order 14→15 |
| 16 | Plant Care             | …018 | **max 60→90**, step 30; order 18→16 |

### RENAME (4) — same service, corrected name; id + FK history preserved
| New order | New name | Old name | id suffix |
|---|---|---|---|
| 2 | Utensil Washing      | Utensils            | …003 |
| 3 | Sweeping and Mopping | Sweeping & Mopping  | …001 |
| 4 | Dusting              | Dusting & Wiping    | …004 |
| 7 | Ironing and Folding  | Ironing & Folding   | …009 |

### NEW (4) — inserted with PLACEHOLDER price (`base_price_cents = 100 = ₹1`)
| New order | Service | id suffix | Durations |
|---|---|---|---|
| 5  | Packing                  | …019 | 30/90/30 |
| 6  | Unpacking                | …020 | 30/90/30 |
| 13 | Fan Cleaning             | …021 | 30/90/30 |
| 17 | Pre and Post Party Clean | …022 | **90/90/0 (fixed)** |

> **Prices are placeholders (₹1).** Real pricing is a separate decision (not part of Step 1).
> Emoji on new rows are provisional; real icons are Step 3.

### DEACTIVATE (5) — off-list; `is_active=false` only (price/id/FKs untouched)
Event Cleaning (…011), Cabinet Cleaning (…013), Car Cleaning (…015), Dog Walking (…016), Gardening (…017).

---

## Migration policy

Forward-only is the live repo policy (`cmd/migrate/main.go:9`; no `down` subcommand). The `.down.sql` carries the
standard disclaimer and exists for **local verification / tooling completeness only** — prod rollback is always a
new corrective forward migration. `App/househelp-api/CLAUDE.md` was **not** edited.

---

## Verification (local, on a throwaway clone of the dev DB — dev DB only read)

Method: `pg_dump househelp_db → scratch_catalog112`, then `up → assert → down → assert → up` via `psql`; scratch dropped after.

| Check | Result |
|---|---|
| `up` applies cleanly (`ON_ERROR_STOP=1`) | ✅ |
| After up: total/active/inactive = **22 / 17 / 5** | ✅ |
| Active set == exactly the 17 target services | ✅ |
| All active `30/90/30` except Party `90/90/0` | ✅ |
| FK orphans — bookings.service_category_id / cart_items.service_id / booking_services.service_id | ✅ 0 / 0 / 0 |
| Deactivated 5 rows still present (ids intact, not deleted) | ✅ |
| `down` restores prior state — **byte-identical diff** vs original dev DB (18 rows) | ✅ |
| `up → down → up` round-trips (back to 22/17) | ✅ |
| Cart pricing golden test (`go test ./internal/booking -run TestGolden_Cart`) | ✅ `ok` (truncation unchanged) |
| No Go source files modified | ✅ |

Truncation safety: all standard tiers are clean multiples of `min=30` (30/60/90 → ×1/×2/×3), so
`base*duration/min` is exact — no truncation drift introduced.

---

## Not in this step
Content tables (Step 2), icons/assets (Step 3), bottom-sheet UI (Step 4). No engine/Go changes — 30/60/90 is purely a data concern.
