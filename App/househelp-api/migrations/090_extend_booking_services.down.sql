DROP INDEX IF EXISTS idx_booking_services_variant;
DROP INDEX IF EXISTS idx_booking_services_bundle;
ALTER TABLE booking_services
    DROP COLUMN IF EXISTS applied_stack_rule_id,
    DROP COLUMN IF EXISTS variant_id,
    DROP COLUMN IF EXISTS bundle_id,
    DROP COLUMN IF EXISTS quantity,
    DROP COLUMN IF EXISTS line_meta;
-- WARNING: narrowing BIGINT back to INTEGER may silently truncate values
-- exceeding 2,147,483,647 paise (~₹21.5M). Verify no large values exist
-- before running this down migration in production.
ALTER TABLE booking_services ALTER COLUMN price_paise TYPE INTEGER USING price_paise::INTEGER;
ALTER TABLE booking_services RENAME COLUMN price_paise TO price_cents;
