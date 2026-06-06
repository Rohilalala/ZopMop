-- The variant/bundle cart model started in 089 was never implemented:
-- service_variants and bundles are empty and no code path writes variant_id or
-- bundle_id. Cart items are keyed by service_id (+ duration_minutes), with
-- idx_cart_items_unique_service_only enforcing dedup for that shape.
--
-- The original cart_item_one_of CHECK demanded exactly one of variant_id /
-- bundle_id be set, so every legacy service-only insert failed with
-- "violates check constraint cart_item_one_of" (SQLSTATE 23514) and the cart
-- add endpoint 500'd. Relax it to only forbid the incoherent case where BOTH
-- variant_id and bundle_id are set; service-only, variant, and bundle rows are
-- all valid. Safe to VALIDATE — existing legacy rows satisfy "not both".
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_item_one_of;
ALTER TABLE cart_items
    ADD CONSTRAINT cart_item_one_of CHECK (
        NOT (variant_id IS NOT NULL AND bundle_id IS NOT NULL)
    );
