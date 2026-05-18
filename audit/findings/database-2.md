# Database & Data Integrity — Audit Findings (Part 2)

Continuation of `database.md`. Part 1 covers Critical / High / Medium
findings. This file holds Low / Nit / Questions.

---

## LOW

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/matching/dispatch.go:144-187]
[CATEGORY: Database / Per-pro DB roundtrip in invite chain]
Finding:
`checkEligibility` issues one DB query per pro in the invite chain
(loop at dispatch.go:388). For each pro it joins users + helpers,
runs an EXISTS for pro_leaves, and an EXISTS for overlapping bookings.
At 20-50 pros considered per booking, that's 20-50 sequential round-
trips serialised on a single goroutine.
Impact:
Each invite chain spans ~100-500ms of DB time at typical pool latency.
At peak (stealth dispatch firing for hundreds of bookings at 7:45pm
IST), this becomes a contention point.
Fix:
Batch eligibility: single query keyed by `WHERE u.id = ANY($1::uuid[])`
returning all five booleans per pro. Caller filters in-process. Reduces
chain DB work from O(N) to O(1).
Evidence:
- internal/matching/dispatch.go:144-205 — per-call query
- internal/matching/dispatch.go:388-416 — loop calling it per pro
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/migrations/008_create_audit_log.up.sql, 023_analytics_schema.up.sql]
[CATEGORY: Database / High-churn tables lack BRIN]
Finding:
`audit_log`, `analytics_events`, `crm_audit_log` all use btree on
`created_at`. Migration 029 added BRIN on `analytics_events.created_at`
(good) but the other two append-only tables didn't follow suit. At a
year of writes the btree indexes grow into hundreds of MB while a BRIN
on `created_at` would be a few hundred KB.
Impact:
Disk/IO cost grows with table size for time-range queries that BRIN
handles cheaply.
Fix:
`CREATE INDEX idx_audit_log_created_brin ON audit_log
   USING BRIN (created_at);`
`CREATE INDEX idx_crm_audit_log_created_brin ON crm_audit_log
   USING BRIN (created_at);`
Keep the btree on `analytics_events` if equality-style queries on it
are also hot (they are, per 028).
Evidence:
- migrations/008_create_audit_log.up.sql:18 — btree only
- migrations/029_runtime_perf_indexes.up.sql:17 — analytics_events got BRIN
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/internal/booking/service.go:1054-1099]
[CATEGORY: Database / Booking-level transaction boundary]
Finding:
Scheduled booking creation:
  1. `CreateScheduledBooking` (tx 1 — bookings + booking_services +
     time_slots capacity)
  2. `IncrementPromoCodeUsage` (tx 2)
  3. `analytics.Track` (writes to analytics_events outside any tx)
  4. `payBookingFromWallet` (tx 3 — wallet + payments + bookings stamp
     + outbox)
  5. `ClearUserCart` (no tx)
If step 4 succeeds and step 5 fails, the customer has paid for a
booking and the cart still has the items — a retry creates a duplicate
booking. The trigger from 060/062 will catch most rapid retries but
not all (different cart, same service category).
Impact:
Edge-case duplicate bookings on cart-clear failure. Customer support
issue, money-handling risk.
Fix:
Either bundle steps 1+4 into a single tx (refund the wallet rollback
becomes a tx rollback), or move ClearUserCart into the booking tx via
the repository (its current location in the service is for separation
of concerns but it's the wrong boundary here).
Evidence:
- internal/booking/service.go:1054-1099 — separate operations
- internal/booking/service.go:1077-1090 — wallet payment after booking commit
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/migrations/056_payments.up.sql:18]
[CATEGORY: Database / Nullable gateway_ref]
Finding:
`payments.gateway_ref TEXT UNIQUE` is nullable — multiple wallet-paid
or COD payments will have gateway_ref = NULL. Postgres allows multiple
NULLs in a UNIQUE column, so this works, but if a future code path
stamps gateway_ref = '' instead of NULL, that empty string will be
unique-constrained. Defensive choice would be to add CHECK
(gateway_ref IS NULL OR gateway_ref <> '').
Impact:
Low likelihood; cosmetic.
Fix:
Add the CHECK. Or partial unique: `CREATE UNIQUE INDEX … WHERE
gateway_ref IS NOT NULL` and drop the bare UNIQUE.
Evidence:
- migrations/056_payments.up.sql:18
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/migrations/060_bookings_dedup.up.sql + 062_*.up.sql]
[CATEGORY: Database / Trigger sees concurrent inserts]
Finding:
The dedup trigger reads `bookings` from inside the BEFORE INSERT
trigger. Two simultaneous inserts in the same 2-minute window can both
fail the EXISTS check (no rows yet) and both commit, because the
EXISTS scan can't see uncommitted inserts from peer transactions. The
trigger comment claims it covers double-tap / retry — true for serial
retries, untrue for actually-concurrent inserts.
Impact:
Rare in practice (true simultaneity at sub-100ms scale is unusual for
a single customer), but possible. Mitigated for the fast-retry case.
Fix:
For airtight dedup either:
  (a) explicit advisory lock keyed on (customer_id, service_category_id)
      at the service layer, or
  (b) move the dedup into a SERIALIZABLE-level read at the start of the
      booking tx with explicit FOR UPDATE on a customer row.
Document the current looseness in 062's preamble.
Evidence:
- migrations/060_bookings_dedup.up.sql:14-27
- migrations/062_bookings_dedup_relax.up.sql:14-30
```

```
[SEVERITY: Low]
[FILE: App/househelp-api/migrations/043_device_tokens.up.sql:25-26]
[CATEGORY: Database / Stale legacy column]
Finding:
Migration 020 added `users.fcm_token`; 043 introduced `device_tokens`
and explicitly comments "the legacy users.fcm_token column is kept
around for backward compat with in-flight app builds; new code reads
from device_tokens." That comment is from over a year ago. The TestFlight
builds and customer apps have all rotated. The legacy column is now
unread but still being potentially written by older app versions.
Impact:
Schema bloat; a hidden data path that bypasses the device_tokens
multi-device model.
Fix:
Drop the column. Idempotent migration: `ALTER TABLE users DROP COLUMN
IF EXISTS fcm_token;`. Confirm no live writer first via
`pg_stat_user_tables` and a code grep.
Evidence:
- migrations/020_add_fcm_tokens.up.sql
- migrations/043_device_tokens.up.sql:3-5 — comment
```

---

## NIT

```
[SEVERITY: Nit]
[FILE: App/househelp-api/migrations/]
[CATEGORY: Database / Repo policy drift]
Finding:
Repo policy (per cmd/migrate/main.go) is forward-only — no .down.sql
files. Practice has drifted: 081-095 ship both .up.sql and .down.sql.
The down files appear to be no-op placeholders but their presence
violates the documented policy and could confuse future operators who
assume golang-migrate will execute them in a rollback.
Fix:
Either codify two-file migrations as the new convention (and remove
the cmd/migrate comment) or delete the down files. Don't leave the
discrepancy.
Evidence:
- cmd/migrate/main.go (policy)
- migrations/081-095_*.down.sql files present
```

```
[SEVERITY: Nit]
[FILE: App/househelp-api/migrations/015_seed_service_categories.up.sql, 025_*.up.sql]
[CATEGORY: Database / Seed data in migrations]
Finding:
Migrations 015, 017, 022, 025, 036, 055, 063, 079, 093 all seed data.
Mixing schema and data in the same migration system means a future
"start fresh" deploy will recreate the data, which is fine for safe
defaults but means the same prod database can't easily be replicated
in a staging environment without also bringing every config + seed.
Some seeds (e.g. 055 localities, 079 NCR zones) are operational data
that probably wants its own seed mechanism (CRM CRUD).
Fix:
Consider splitting structural migrations from seed/data migrations. A
common pattern is two streams: `schema/NNN_*.sql` and `seed/NNN_*.sql`.
Out of scope for an immediate fix; flagging for hygiene.
```

```
[SEVERITY: Nit]
[FILE: App/househelp-api/migrations/073_consent_versions.up.sql:5-10 + 077_users_privacy_policy.up.sql]
[CATEGORY: Database / Migration ordering self-heal]
Finding:
Migration 073's comment explains it self-heals a prior ordering bug —
it adds columns that migration 077 (running later by number but logically
earlier) was supposed to add. The fix is in place but the duplicated
column addition is technical debt. A reader of 077 has no signal that
the column may already exist; readers of 073 don't know why columns
referenced by 077 are added in 073.
Fix:
Add a cross-reference comment in both files. Long-term, consolidate
into a single migration when next reorganising.
Evidence:
- migrations/073_consent_versions.up.sql:5-10
- migrations/077_users_privacy_policy.up.sql:6-8
```

---

## QUESTIONS FOR ADITYA

1. **booking_services.price_cents vs price_paise** — Migration 094 is
   queued / partially applied to prod, but `internal/booking/repository.go`
   still emits SQL with `price_cents`. Is the variant-aware booking
   writer slated for a near-term port, or should 094 be rolled back
   until the code catches up? This is the same shape as the May 14
   incident and will repeat if 094 lands without code changes.
2. **cart_items legacy unique** — Migration 095 drops
   `cart_items_cart_id_service_id_key`, which `internal/cart/repository.go`
   relies on via `ON CONFLICT (cart_id, service_id) DO UPDATE`. Is the
   cart writer port to variant_id / quantity scheduled, or is 095
   intentionally blocked?
3. **Hard-delete addresses** — Is the partial implementation of
   migration 061 (column added, not used) intentional (e.g. waiting on
   a privacy-by-design switch) or a forgotten task?
4. **Down migrations** — Codify the practice or remove the files?
