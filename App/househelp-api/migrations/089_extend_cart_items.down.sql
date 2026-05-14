DROP INDEX IF EXISTS idx_cart_items_unique_variant;
DROP INDEX IF EXISTS idx_cart_items_unique_bundle;
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_item_one_of;
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_item_qty_bounded;
ALTER TABLE cart_items
    DROP COLUMN IF EXISTS variant_id,
    DROP COLUMN IF EXISTS bundle_id,
    DROP COLUMN IF EXISTS quantity,
    DROP COLUMN IF EXISTS line_meta;
-- Restore original single-service-per-cart constraint.
ALTER TABLE cart_items ADD CONSTRAINT cart_items_cart_id_service_id_key UNIQUE (cart_id, service_id);
