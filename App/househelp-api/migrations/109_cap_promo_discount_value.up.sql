-- 109_cap_promo_discount_value.up.sql
-- Money audit LB-5: cap promotions.discount_value so an admin typo
-- (e.g. percent value 10000 meant as 10) cannot mint mass-free
-- bookings. Defense in depth — handler also validates.
--
-- Bounds:
--   discount_type='percent' -> 1..100        (i.e. 1%..100%)
--   discount_type='fixed'   -> 1..1_000_000  (i.e. ₹0.01..₹10,000 in paise)
--
-- Repo policy: forward-only migrations (see App/househelp-api/CLAUDE.md
-- "Don't write .down.sql migrations"). Manual rollback SQL for ops:
--   ALTER TABLE promotions DROP CONSTRAINT promotions_discount_value_bounds;

ALTER TABLE promotions
  ADD CONSTRAINT promotions_discount_value_bounds
  CHECK (
    discount_value > 0 AND (
      (discount_type = 'percent' AND discount_value <= 100) OR
      (discount_type = 'fixed'   AND discount_value <= 1000000)
    )
  );
