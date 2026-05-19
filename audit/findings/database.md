# Database & Data Integrity — Audit Findings

Scope: Postgres/PostGIS schema and access patterns under
`App/househelp-api/`. Migrations 001–095 reviewed chronologically. All
repositories and service-layer access paths spot-checked for N+1,
transactional integrity, race conditions, cascade correctness, and money
typing consistency.

## Severity counts

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High     | 6 |
| Medium   | 9 |
| Low      | 6 |
| Nit      | 3 |

---

## CRITICAL

```
[SEVERITY: Critical]
[FILE: App/househelp-api/internal/booking/repository.go:678, :734]
[CATEGORY: Database / Schema drift]
Finding:
`CreateScheduledBooking` inserts into `booking_services` using the column
name `price_cents`. The same repository's list query at line 734 also
selects `bs.price_cents`. Migration 090 renamed `booking_services.price_cents`
→ `price_paise`, and migration 094 (the 2026-05-15 recovery migration)
made the rename idempotent so every environment ends up with the new name.
Once 094 runs on prod, every scheduled booking creation will fail with
`ERROR: column "price_cents" of relation "booking_services" does not
exist`, and every customer booking-list query will throw the same error.
Impact:
Total breakage of:
  • New scheduled bookings (CreateScheduledBooking)
  • New instant-from-cart bookings (same code path)
  • Customer "Upcoming" / "Past" bookings list (GetCustomerBookingsByStatus)
This is the same pattern that caused the 2026-05-14 incident — the code
was rolled back to `price_cents` to keep prod running. Migration 094's
preamble explicitly notes that the rename must happen "at the same time
as the variant-based cart code rolls out", but the variant-based booking
write path has not yet been ported. The two are now drifting.
Fix:
Either (a) rename the columns back in the repository to `price_paise`,
or (b) defer migration 094 until after the booking writer is ported.
The CLAUDE.md memory entry for the incident also says "future deploy
must re-rename price_paise" — but the SQL strings in
`internal/booking/repository.go` still reference `price_cents`. The
deploy of migration 094 will break prod the moment it runs.
Evidence:
- migrations/090_extend_booking_services.up.sql:9 — `RENAME COLUMN price_cents TO price_paise`
- migrations/094_rerename_booking_services_price.up.sql — idempotent rename
- internal/booking/repository.go:678 — `INSERT INTO booking_services (..., price_cents)`
- internal/booking/repository.go:734 — `'price_cents', bs.price_cents` in json_build_object
```

```
[SEVERITY: Critical]
[FILE: App/househelp-api/internal/addresses/repository.go:31-67, :209]
[CATEGORY: Database / Soft-delete consistency]
Finding:
Migration 061 added a `deleted_at` column to `user_addresses` and a
partial index, with the explicit comment:
  "Addresses are referenced by past bookings via FK, so a hard DELETE
   fails. Switch to UPDATE-to-mark-deleted and filter ListByUser by
   `deleted_at IS NULL`."
Neither half of that switch is implemented:
  • `Delete()` at line 209 still does a hard `DELETE FROM user_addresses`.
  • `ListByUser()` at line 31-67 selects every row with no `deleted_at`
    filter — there are no soft-deleted rows to filter because nothing
    writes deleted_at — but if a future deploy actually starts soft-
    deleting, the list query will return tombstones.
  • Worse, the hard-DELETE path at line 201 NULLs every booking's
    `address_id`, destroying the historical record of where the booking
    was placed. The booking address was specifically supposed to survive
    address deletion via the FK + soft-delete.
Impact:
1. Booking history loses its location once the customer deletes the
   saved address — undermines a documented design intent ("preserve
   historical records").
2. The migration's stated design is silently disabled. Any operator
   reading 061 will assume soft-delete is live; it isn't.
3. The hard delete only works because of the booking nullification —
   if a row in any other table FK's user_addresses (e.g. address_groups
   is checked, but future FKs may not be), deletion will fail with 23503.
Fix:
Implement the switch as 061 intended:
  • Replace the DELETE with `UPDATE user_addresses SET deleted_at = NOW()
    WHERE id = $1 AND user_id = $2`.
  • Add `AND deleted_at IS NULL` to ListByUser, Delete, ExistsCheck,
    address-lookup paths in booking/service.go:1144 etc.
  • Remove the `UPDATE bookings SET address_id = NULL` step so history
    is preserved.
Evidence:
- migrations/061_addresses_soft_delete.up.sql — adds column + partial index
- internal/addresses/repository.go:179 — existence check has no deleted_at
- internal/addresses/repository.go:201 — booking address_id nullification
- internal/addresses/repository.go:209 — hard DELETE
- internal/booking/service.go:1145 — booking creation lookup has no deleted_at
```

---

## HIGH

```
[SEVERITY: High]
[FILE: App/househelp-api/migrations/090_extend_booking_services.up.sql, 094_*.up.sql, 095_*.up.sql]
[CATEGORY: Database / Migration coupling]
Finding:
Migrations 089/090 caused the 2026-05-14 prod incident (per user memory
+ migration 094/095 preambles): the SQL renamed columns the live binary
was still reading. Migrations 094 and 095 ship the "official recovery"
that allows prod to converge to the post-rename schema. But:
  • 094's safety hinges on the deployed binary already using
    `price_paise` for booking_services. Repository code still uses
    `price_cents` (see Critical #1). Re-running 094 in prod will recreate
    the same 2026-05-14 outage.
  • 095 drops `cart_items_cart_id_service_id_key` — the same legacy
    UNIQUE that 089 attempted to remove. The dependent code path (cart
    insertion using ON CONFLICT (cart_id, service_id)) is in
    `internal/cart/repository.go:54-59`. If that ON CONFLICT clause is
    still live, 095 turns it into ON CONFLICT against a non-existent
    constraint → 42P10 error. Confirm cart writers are migrated to the
    variant-keyed unique indexes (089's partial uniques) before re-deploy.
Impact:
Re-running these migrations on prod will repeat the May 14 outage
exactly. The deploy gate must inspect the booking + cart writer code
for `price_cents` and ON CONFLICT (cart_id, service_id) BEFORE pushing
094 or 095 again. Worth adding to the preflight check.
Fix:
- Add a CI check that fails the build if `price_cents` appears in any
  SQL string in `internal/booking/`.
- Audit cart insertion: migrate to variant/bundle-keyed conflict
  resolution before 095 lands.
- Consider gating 094/095 behind a feature flag or a schema version
  guard so the migration runner can detect partial deploys.
Evidence:
- migrations/094_rerename_booking_services_price.up.sql:6-15 — note "live code kept working"
- migrations/095_drop_legacy_cart_items_unique.up.sql:1-5 — note "089 was reverted on prod"
- internal/cart/repository.go:54 — INSERT INTO cart_items with price_cents (legacy ok)
- internal/cart/repository.go (entire file lacks variant_id / bundle_id writes)
```

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/cart/repository.go]
[CATEGORY: Database / Variant model regression]
Finding:
Migration 089 added cart_items.variant_id / bundle_id / quantity /
line_meta and added new UNIQUE indexes on (cart_id, variant_id) and
(cart_id, bundle_id), plus a CHECK that exactly one of variant_id /
bundle_id must be set. The cart repository never writes those columns
or reads them. It still keys cart items by (cart_id, service_id) and
uses ON CONFLICT (cart_id, service_id) DO UPDATE — the constraint that
migration 095 drops.
Impact:
- After 095 is applied, the ON CONFLICT clause will raise SQLSTATE 42P10
  ("there is no unique or exclusion constraint matching the ON CONFLICT
  specification"). Cart-add will return 500 on every request.
- The CHECK `cart_item_one_of` (added NOT VALID in 089) will fire as
  soon as the constraint is validated: every legacy cart_item row has
  variant_id = NULL AND bundle_id = NULL, which violates the CHECK.
- Customers can't actually book bundles or variants from the customer
  app — the cart code doesn't know about them.
Fix:
Port cart writers to variant_id + quantity in lockstep with migrations
089 / 095. The cart writer is the gate; nothing else can ship until it
moves over.
Evidence:
- migrations/089_extend_cart_items.up.sql:4-31 — variant + bundle + CHECK + unique partial indexes
- migrations/095_drop_legacy_cart_items_unique.up.sql:5 — drops the unique 089's ON CONFLICT relies on
- internal/cart/repository.go:54-59 — ON CONFLICT (cart_id, service_id) DO UPDATE
```

```
[SEVERITY: High]
[FILE: App/househelp-api/internal/booking/repository.go:113-145]
[CATEGORY: Database / Race condition]
Finding:
`UpdateBookingStatus` reads the current booking row (line 115:
`r.getBookingByID(ctx, ...)`), validates the transition in Go (line
120: `isValidTransition`), and then issues an UPDATE in a different
round-trip outside any transaction. Two concurrent calls (e.g. a helper
marks the job complete while the customer cancels) can both pass the
read-time validation and then both issue their UPDATE — the second
write quietly overwrites the first because there is no `WHERE status =
$prevStatus` guard.
Impact:
Inconsistent terminal states. Possible "completed" → "cancelled" or
vice-versa transitions that the validator was supposed to forbid. The
booking's status, cancelled_at, completed_at, started_at can end up
contradicting each other.
Fix:
Move the transition check INTO the UPDATE:
  UPDATE bookings SET status = $newStatus, updated_at = NOW(),
                     started_at = CASE WHEN $newStatus='in_progress' THEN NOW() ELSE started_at END,
                     completed_at = CASE WHEN $newStatus='completed' THEN NOW() ELSE completed_at END
  WHERE id = $bookingID AND status = $expectedFromStatus
  RETURNING ...;
If RowsAffected == 0, return ErrInvalidTransition. This is the same
pattern AcceptBooking already uses correctly (repository.go:359-369).
Evidence:
- internal/booking/repository.go:113-145 — non-transactional read-then-write
- internal/booking/repository.go:328-389 — correct atomic CAS pattern (use this everywhere)
```

```
[SEVERITY: High]
[FILE: App/househelp-api/migrations/067_wallets.up.sql:21-31]
[CATEGORY: Database / Wallet ledger missing constraint]
Finding:
`wallet_transactions` allows `amount_paise` of any sign, but there is no
CHECK linking sign to `kind`. A 'topup' with a negative amount, or a
'spend' with a positive amount, would corrupt downstream reconciliation
(the service layer enforces this; nothing at the DB layer does).
There is also no guard against `booking_id`/`payment_id` being NULL for
kinds that require them — the table comment says "required at service
layer for kind='spend'" but a future code path could insert without it
and the row would be accepted.
Impact:
A single bad code path (or a manual SQL fix) corrupts the wallet ledger
silently. balance_after is also not constrained to match `balance_paise`
on the wallets table at write time — divergence would be invisible until
a full reconcile job.
Fix:
Add:
  CHECK (
    (kind IN ('topup','refund_credit','referral_credit','adjustment') AND amount_paise >= 0)
    OR (kind = 'spend' AND amount_paise <= 0)
    OR (kind = 'reversal')
  )
  CHECK ((kind = 'spend' AND booking_id IS NOT NULL) OR kind <> 'spend')
  CHECK ((kind = 'topup' AND payment_id  IS NOT NULL) OR kind <> 'topup')
Evidence:
- migrations/067_wallets.up.sql:21-31 — table definition lacks linking CHECKs
- migrations/083_referrals.up.sql:25-27 — extends the kind enum; same gap
```

```
[SEVERITY: High]
[FILE: App/househelp-api/migrations/004_create_bookings.up.sql:7]
[CATEGORY: Database / Missing FK]
Finding:
`bookings.helper_id` references `users(id)` (line 7 of 004), NOT
`helpers(id)`. The helpers table extends users with the same UUID PK,
so any valid helper-user-id will resolve, but a `customer` role UUID
will also be accepted as a helper_id. There is no role-level
enforcement at the schema layer.
A booking accepted by a non-helper account (e.g. via a buggy assign
path or direct SQL) becomes unfindable to the matching/payouts logic
because `helpers` won't contain the row.
Impact:
Data drift. The matching engine and payouts will silently skip such
bookings; the customer sees an "accepted" booking with no live pro.
Fix:
Change the FK to `REFERENCES helpers(id) ON DELETE SET NULL`. This is
a schema break — migrate any existing rows where helper_id points to
a non-helper to NULL first, then add the constraint. Same recommendation
for `bookings.cancelled_by` (which is just TEXT today and could be made
ENUM-safe via a CHECK constraint).
Evidence:
- migrations/004_create_bookings.up.sql:7 — helper_id REFERENCES users(id)
- migrations/078_reviews.up.sql:10 — by contrast, reviews.helper_id REFERENCES helpers(id) (correct)
```

```
[SEVERITY: High]
[FILE: App/househelp-api/migrations/050_pro_leaves.up.sql:13-16]
[CATEGORY: Database / Inconsistent FK shape]
Finding:
`pro_leaves.pro_id REFERENCES users(id)`. Same issue as helper_id — a
"leave" can be declared against a customer UUID. More importantly, the
table joins on the assumption that a pro_id is a helper, and the leave
service uses it to filter bookings via `helper_id`. The lazy
monthly-reset path on `helpers.leave_balance` (50-1) reads/writes
helpers but the leave declarations key off users.
Impact:
Data integrity bypass — a customer ID can be inserted as pro_id and the
DB accepts it. Operationally low risk (only admin code creates these)
but a defence-in-depth gap.
Fix:
`pro_id REFERENCES helpers(id) ON DELETE CASCADE`. Migrate any orphan
rows first.
Evidence:
- migrations/050_pro_leaves.up.sql:20 — pro_id REFERENCES users(id)
- migrations/050_pro_leaves.up.sql:13-16 — leave_balance is on helpers(id)
- internal/matching/dispatch.go:162 — leave check filters by pro_id, joined with helper context
```

---

## MEDIUM

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/experts/repository.go:35-53]
[CATEGORY: Database / Index gap on hot subquery]
Finding:
`Repository.List` runs a correlated subquery `SELECT COUNT(*) FROM
bookings WHERE customer_id = $1 AND helper_id = $2 AND status =
'completed'` for every expert in the list. There is no composite index
on (customer_id, helper_id, status). Existing indexes are
(customer_id, created_at DESC) (028), (helper_id, created_at DESC)
(029), and (status, created_at DESC) (028) — none aligns with the
subquery's filter shape.
Impact:
At small scale this is a heap scan on a few rows — invisible. At a few
thousand bookings per customer it becomes a measurable per-row penalty.
Customer "Your Experts" screen latency grows linearly with bookings.
Fix:
Add: `CREATE INDEX idx_bookings_customer_helper_status
       ON bookings (customer_id, helper_id) WHERE status = 'completed';`
Or rewrite as a LEFT JOIN + GROUP BY in the outer query so the planner
can hash-aggregate once.
Evidence:
- internal/experts/repository.go:41-46 — correlated subquery per row
- migrations/028_query_perf_indexes.up.sql — existing indexes don't cover the predicate
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/migrations/002_create_helpers.up.sql:9-11]
[CATEGORY: Database / Double-tracked geometry]
Finding:
Helpers store location in three places:
  • `current_lat DECIMAL(10,8)`
  • `current_lng DECIMAL(11,8)`
  • `location GEOGRAPHY(POINT, 4326)`
The matching engine reads `location` (the geography column); writers
must keep all three in sync. `UpdateLocation` in helper/repository.go
does write all three (`ST_SetSRID(ST_MakePoint…)::geography`), but
nothing in the schema prevents drift — a manual UPDATE on just
current_lat will leave `location` stale and the helper invisible to
dispatch.
Impact:
Operational hazard. Admin SQL-edit of a helper's lat/lng won't update
the spatial index; the helper drops off the matcher silently.
Fix:
Either:
  (a) compute `location` from current_lat/current_lng via a
      GENERATED ALWAYS AS column (Postgres 12+ supports this), or
  (b) drop the two scalar columns and read lat/lng via
      ST_Y/ST_X off the geography on the rare occasions it's needed.
Evidence:
- migrations/002_create_helpers.up.sql:9-11
- internal/helper/repository.go:221-231 — manual three-way sync
- internal/helper/repository.go:198-206 — GetLastLocation reads scalar lat/lng (would drift)
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/migrations/078_reviews.up.sql:22-37]
[CATEGORY: Database / Trigger performance]
Finding:
The `fn_reviews_recompute_helper_rating` trigger fires on every INSERT
and UPDATE OF rating, and recomputes `AVG(rating)` over all reviews
for the helper. At small N this is fine; at 10k+ reviews per veteran
helper the recompute scans every review on every new review insert.
There is an index `idx_reviews_helper_created (helper_id, created_at)`
which the planner can use but the AVG still touches every row.
Impact:
Review writes get slower as a helper accumulates history. The trigger
also writes the AVG back to `helpers.rating`, which on a large helper
table can cause heap bloat from frequent updates of a NUMERIC(3,2)
column. No HOT update guarantee.
Fix:
Maintain rating incrementally: store total_reviews and rating_sum on
helpers, update both with delta math (`sum += new_rating; count += 1;
helpers.rating = sum/count`). Or move to materialized aggregation on a
cron schedule if reads can tolerate seconds-level staleness.
Evidence:
- migrations/078_reviews.up.sql:22-37 — full re-aggregation on every event
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/migrations/089_extend_cart_items.up.sql:14-18, :30]
[CATEGORY: Database / Unvalidated constraints]
Finding:
Both `cart_item_one_of` and `cart_item_qty_bounded` constraints are
added NOT VALID and the follow-up VALIDATE has not been run. The
comment on line 12-13 says "A follow-up migration should backfill
variant_id from a default variant and then run ALTER TABLE cart_items
VALIDATE CONSTRAINT cart_item_one_of." That follow-up never landed.
Impact:
The constraints fire only on new writes — and only when the new column
is set, which (per High #4) it never is. The constraints are effectively
dead until both halves land.
Fix:
After porting the cart writer (High #4):
  UPDATE cart_items
     SET variant_id = (SELECT id FROM service_variants
                       WHERE service_id = cart_items.service_id
                         AND is_default = true)
   WHERE variant_id IS NULL AND bundle_id IS NULL;
  ALTER TABLE cart_items VALIDATE CONSTRAINT cart_item_one_of;
  ALTER TABLE cart_items VALIDATE CONSTRAINT cart_item_qty_bounded;
Evidence:
- migrations/089_extend_cart_items.up.sql:18,30 — NOT VALID
- No migrations/NNN_validate_cart_items.up.sql exists
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/migrations/043_device_tokens.up.sql:38-57]
[CATEGORY: Database / FK shape inconsistency]
Finding:
`device_tokens.worker_id` references `users(id)` not `helpers(id)`,
mirroring the same issue as bookings.helper_id and pro_leaves.pro_id.
The CHECK at line 16 forces exactly one of (user_id, worker_id) to be
set but doesn't enforce that worker_id is actually a pro.
A bug in the register endpoint could route a customer's token to the
worker_id column; the table would happily store it and the next pro
notification blast could target customer tokens.
Impact:
Cross-role notification leak (low-likelihood but high-impact: a customer
gets a "new booking" push). Per-row CHECK constraint can't enforce
this; the writer would need a sub-select.
Fix:
Hardest fix is to repoint the FK to `helpers(id)`. Easier: a BEFORE
INSERT/UPDATE trigger that rejects rows where the worker_id has no
matching helpers row.
Evidence:
- migrations/043_device_tokens.up.sql:10 — worker_id REFERENCES users(id)
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/migrations/004_create_bookings.up.sql:8, migrations/091_*.up.sql]
[CATEGORY: Database / Stale FK index]
Finding:
`bookings.service_category_id` is NOT NULL in the original schema (004)
and is made nullable by 091 ("For multi-line cart bookings,
service_category_id is meaningless"). The original FK
`REFERENCES service_categories(id)` stays. There is no index on the
column. `service_category_id` is rarely read now (091 says it's
meaningless), but the unindexed FK still blocks parent deletes — every
`DELETE FROM service_categories` triggers a full booking scan to
validate.
Impact:
Service catalog deletions will lock the bookings table at scale.
Operationally low-likelihood (admins don't usually delete categories)
but a defensive miss.
Fix:
`CREATE INDEX idx_bookings_service_category_id ON bookings
   (service_category_id) WHERE service_category_id IS NOT NULL;`
Or, if 091's "meaningless" wording is final intent: drop the column
entirely once migrations stabilise.
Evidence:
- migrations/091_bookings_nullable_service_category.up.sql
- No supporting index in migrations/028, 029
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/internal/booking/repository.go:583-693]
[CATEGORY: Database / Per-row inserts inside transaction]
Finding:
`CreateScheduledBooking` inserts one row per booking_service inside a
single transaction (line 676 `for _, item := range items`). At up to 10
cart items this is 10 round-trips while the tx holds a slot row lock.
A burst of concurrent bookings on the same slot will serialise on the
slot lock; per-booking latency = round-trip * (items + ~3 fixed).
Impact:
Limits booking throughput per slot. At Indian peak hours (Sunday
mornings) this becomes the bottleneck.
Fix:
Use `pgx.CopyFrom` for booking_services, or build a single
`INSERT INTO booking_services SELECT * FROM unnest($1::uuid[],
$2::int[], $3::bigint[]) AS …`. One round-trip instead of N.
Evidence:
- internal/booking/repository.go:676-685
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/migrations/034_pending_refunds.up.sql:5, :11]
[CATEGORY: Database / Money type drift]
Finding:
`pending_refunds.amount_cents BIGINT` — both the column name and most
of the codebase uses "cents" terminology while the actual currency is
paise (per migration 065's rename). `payments.amount_paise` (056),
`wallets.balance_paise` (067), `bookings.amount_paise` (065 post-
rename) all use paise; the refund table uses "cents". The column type
is correct (BIGINT, signed) but the name is misleading and the
booking-cancellation code at booking/repository.go:209 passes
`refundAmount = priceCents - discountCents - int64(feeCents)` to the
amount_cents column — those source values are paise too, so the value
is correct but readers will be confused.
Impact:
Cognitive load + future bug magnet. Already noted as an issue in 065's
preamble ("'cents' naming was always a misnomer").
Fix:
Rename `pending_refunds.amount_cents` → `amount_paise` and
`partial_amount_cents` → `partial_amount_paise` in a paired migration
+ code deploy (carefully — see lessons from 089/090 incident).
Evidence:
- migrations/034_pending_refunds.up.sql:4 — amount_cents BIGINT
- migrations/046_refund_gateway.up.sql:22 — partial_amount_cents BIGINT
- migrations/065_bookings_amount_paise.up.sql — established paise convention
```

```
[SEVERITY: Medium]
[FILE: App/househelp-api/migrations/048_booking_cancellation_fee.up.sql:7]
[CATEGORY: Database / Money type drift]
Finding:
`cancellation_fee_cents INTEGER NOT NULL DEFAULT 0` — again named cents
but stores paise. Type is INTEGER (32-bit) not BIGINT. Mathematically a
fee can't exceed an order, and orders are BIGINT, so cents-as-INTEGER
could overflow if a future logic chain misuses it (e.g. a full-order
refund routed as a "fee"). Inconsistent with bookings.amount_paise
which is BIGINT.
Impact:
Low likelihood overflow; high likelihood naming confusion.
Fix:
Same migration as Medium above: rename to `cancellation_fee_paise` and
widen to BIGINT.
Evidence:
- migrations/048_booking_cancellation_fee.up.sql:7
```

---

Low / Nit / Questions continue in `database-2.md`.

