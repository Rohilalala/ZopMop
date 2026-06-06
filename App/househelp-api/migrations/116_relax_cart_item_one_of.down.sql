-- Restore the original 089 constraint: exactly one of variant_id / bundle_id.
-- NOT VALID to skip any existing service-only rows that would otherwise fail.
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_item_one_of;
ALTER TABLE cart_items
    ADD CONSTRAINT cart_item_one_of CHECK (
        (variant_id IS NOT NULL AND bundle_id IS NULL) OR
        (variant_id IS NULL AND bundle_id IS NOT NULL)
    ) NOT VALID;
