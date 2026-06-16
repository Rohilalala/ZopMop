-- CRM promos bug fix: validateCreateRequest enforced only discount bounds,
-- so min_order_cents / max_uses / max_per_user accepted negative values that
-- could weaken redemption caps at booking time (money exposure). The Go
-- layer now rejects negatives; this CHECK is defense-in-depth, mirroring
-- promotions_discount_value_bounds (migration 109).
--
-- NOT VALID: enforced on every INSERT/UPDATE going forward, but skips the
-- one-time full-table scan so the migration can never fail on a legacy row
-- written before the Go guard landed. Rollback:
--   ALTER TABLE promotions DROP CONSTRAINT promotions_caps_nonneg;
ALTER TABLE promotions
  ADD CONSTRAINT promotions_caps_nonneg
  CHECK (min_order_cents >= 0 AND max_uses >= 0 AND max_per_user >= 0) NOT VALID;
