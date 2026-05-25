# LB-5 Fix Design — Cap `promotions.discount_value`

**Finding:** `audit/money/findings-math.md` §C-1.
**Risk:** Admin CRM user can mint mass-free-booking coupons by typo
(`discount_value=10000` meant as 10 → 100× over-discount → cart clamps
to ₹0). Same risk on fixed-type by typing extra zeros.

## Limits (single source of truth)

| `discount_type` | Max `discount_value` | Meaning |
|---|---|---|
| `percent` | 100 | 100 % off |
| `fixed`   | 1 000 000 | ₹10 000 (paise) |

Min for both: 1 (strictly positive). 0 / negative already rejected today.

## Layer 1 — DB CHECK constraint (migration 109)

`migrations/109_cap_promo_discount_value.up.sql`:

```sql
ALTER TABLE promotions
  ADD CONSTRAINT promotions_discount_value_bounds
  CHECK (
    discount_value > 0 AND (
      (discount_type = 'percent' AND discount_value <= 100) OR
      (discount_type = 'fixed'   AND discount_value <= 1000000)
    )
  );
```

Repo policy is forward-only (`App/househelp-api/CLAUDE.md` →
"Don't write `.down.sql` migrations"). No down migration ships.
PR description will document rollback SQL for ops.

## Layer 2 — Handler validation

Extract `validateCreateRequest(req CreateRequest) error` in
`internal/crm/promos/promos.go`. Called from both `Create` and `Update`.

Rules:
- `discount_type` must be `"percent"` or `"fixed"`.
- `discount_value > 0`.
- if `percent` → `discount_value <= 100`.
- if `fixed`   → `discount_value <= 1_000_000`.
- Returns sentinel-wrapped error with HTTP 400 (handler already
  returns `BadRequest` on repo errors).

Existing `DiscountValue <= 0` check in `Create` (line 165) gets
removed in favor of the shared validator. Update path currently
runs no validation — same validator wired in.

## Layer 3 — CRM form

`App/zopmop-crm/src/pages/PromosPage.tsx:163` — add `min={1}` plus
dynamic `max` (`100` when type=percent, `1000000` when type=fixed)
to the `<input>`. Belt-and-braces; the server is load-bearing.

## Tests

Backend unit tests in new file
`internal/crm/promos/validate_test.go`:

| Case | Expected |
|---|---|
| percent, value=1   | ok |
| percent, value=100 | ok |
| percent, value=101 | error |
| fixed, value=1     | ok |
| fixed, value=1_000_000 | ok |
| fixed, value=1_000_001 | error |
| any, value=0       | error |
| any, value=-1      | error |
| invalid type       | error |

Migration smoke: handled via `make preflight` (compose-driven
DB boot already runs CHECK on every insert). A focused integration
test is out of scope — boundary cases are covered at handler layer
and a CHECK violation surfaces as a Postgres error in the existing
e2e booking flow if regressed.

## Backfill

Pre-PR: `SELECT id, code, discount_type, discount_value FROM promotions
WHERE NOT (discount_value > 0 AND ((discount_type='percent' AND
discount_value<=100) OR (discount_type='fixed' AND
discount_value<=1000000)));`

If any rows → list in PR body, do **not** auto-fix. Admin decides.
If zero rows (pre-pilot likely) → note "no violating rows" in PR.

## Out of scope (follow-ups)

- H-3 percent-promo truncation (separate finding, separate PR).
- Tightening `discount_value` to per-type column types (would need
  a wider schema migration).
