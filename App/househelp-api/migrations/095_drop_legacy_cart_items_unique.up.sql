-- After 2026-05-14 incident: migration 089 was reverted on prod DB so the live
-- ON CONFLICT (cart_id, service_id) cart code kept working. This drop runs at the
-- same time as the variant-based cart code rolls out. New partial unique indexes
-- on (cart_id, variant_id) and (cart_id, bundle_id) already exist from 089.
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_cart_id_service_id_key;
