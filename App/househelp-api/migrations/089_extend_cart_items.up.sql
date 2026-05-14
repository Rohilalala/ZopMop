-- Cart needs to store variant selection AND bundle selection.
-- A cart item is either (variant_id) or (bundle_id), never both.

ALTER TABLE cart_items
    ADD COLUMN IF NOT EXISTS variant_id  UUID REFERENCES service_variants(id),
    ADD COLUMN IF NOT EXISTS bundle_id   UUID REFERENCES bundles(id),
    ADD COLUMN IF NOT EXISTS quantity    INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS line_meta   JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Constraint: exactly one of variant_id or bundle_id must be set on new/updated rows.
-- NOT VALID skips existing rows (pre-variant cart items keyed by service_id only).
-- A follow-up migration should backfill variant_id from a default variant and then
-- run ALTER TABLE cart_items VALIDATE CONSTRAINT cart_item_one_of.
ALTER TABLE cart_items
    ADD CONSTRAINT cart_item_one_of CHECK (
        (variant_id IS NOT NULL AND bundle_id IS NULL) OR
        (variant_id IS NULL AND bundle_id IS NOT NULL)
    ) NOT VALID;

-- Drop the legacy UNIQUE (cart_id, service_id) — we want multiple variants of same service allowed
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_cart_id_service_id_key;

-- Add a per-item unique on (cart_id, variant_id) and (cart_id, bundle_id) to prevent dup adds
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_unique_variant
    ON cart_items (cart_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_unique_bundle
    ON cart_items (cart_id, bundle_id) WHERE bundle_id IS NOT NULL;

-- Quantity bounded (also NOT VALID — pre-existing rows have quantity=1 default, but explicit anyway).
ALTER TABLE cart_items
    ADD CONSTRAINT cart_item_qty_bounded CHECK (quantity >= 1 AND quantity <= 20) NOT VALID;
