-- Mirror cart_items: a booking line is either a variant or a bundle.
ALTER TABLE booking_services
    ADD COLUMN IF NOT EXISTS variant_id  UUID REFERENCES service_variants(id),
    ADD COLUMN IF NOT EXISTS bundle_id   UUID REFERENCES bundles(id),
    ADD COLUMN IF NOT EXISTS quantity    INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS line_meta   JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Widen price_cents to BIGINT and rename to price_paise (audit-flagged bug)
ALTER TABLE booking_services RENAME COLUMN price_cents TO price_paise;
ALTER TABLE booking_services ALTER COLUMN price_paise TYPE BIGINT USING price_paise::BIGINT;

-- Add applied_stack_rule_id to track which stack rule was applied at booking time (for reporting)
ALTER TABLE booking_services
    ADD COLUMN IF NOT EXISTS applied_stack_rule_id UUID REFERENCES stack_rules(id);

CREATE INDEX IF NOT EXISTS idx_booking_services_variant ON booking_services (variant_id);
CREATE INDEX IF NOT EXISTS idx_booking_services_bundle ON booking_services (bundle_id);
