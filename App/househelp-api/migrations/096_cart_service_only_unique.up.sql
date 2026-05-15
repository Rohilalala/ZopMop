-- Add the third partial unique index covering service-only cart rows.
--
-- Migration 095 dropped the legacy `cart_items_cart_id_service_id_key`
-- UNIQUE constraint without adding a service-only replacement. Migration
-- 089 added partial unique indexes on (cart_id, variant_id) and
-- (cart_id, bundle_id) but those only fire when variant_id or bundle_id
-- is non-NULL. The current customer mobile build sends service-only
-- adds (no variant/bundle), so the cart writer's `ON CONFLICT
-- (cart_id, service_id)` had no matching index and was 42P10-erroring
-- on every cart add since migration 095 went live on prod (2026-05-15).
--
-- This index restores the upsert path for the service-only case.
-- Forward-only per repo policy; safe to reapply (`IF NOT EXISTS`).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_unique_service_only
  ON cart_items (cart_id, service_id)
  WHERE variant_id IS NULL AND bundle_id IS NULL;
