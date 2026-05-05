-- 065_bookings_amount_paise.sql
-- Renames bookings.price_cents → bookings.amount_paise and
-- bookings.discount_cents → bookings.discount_paise, widening both to BIGINT.
-- The "cents" naming was always a misnomer: every value in these columns has
-- always been Indian paise. This migration is purely lexical — no data
-- mutation, no multiplication. Type widens from INTEGER to BIGINT so we
-- match the rest of the codebase (payments.amount_paise, wallets.balance_paise).
--
-- ────────────────────────────────────────────────────────────────────────────
-- MANUAL APPLY ORDER — read before running this migration:
--
-- The Go code in this commit references the new column names
-- (amount_paise, discount_paise). Applying this migration BEFORE deploying
-- the new code will break every booking read/write the moment psql commits,
-- because every SQL string in the deployed binary still references
-- price_cents / discount_cents and will fail with "column does not exist".
--
-- Required apply order:
--   1. Deploy the Go binary built from this commit (or atomically with step 2).
--   2. Run this migration via psql.
--
-- A single-PR deploy where binary + migration roll out together satisfies
-- this. A blue/green or canary deploy must hold the migration until all
-- old replicas are drained.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE bookings
  RENAME COLUMN price_cents TO amount_paise;

ALTER TABLE bookings
  ALTER COLUMN amount_paise TYPE BIGINT;

ALTER TABLE bookings
  RENAME COLUMN discount_cents TO discount_paise;

ALTER TABLE bookings
  ALTER COLUMN discount_paise TYPE BIGINT;
