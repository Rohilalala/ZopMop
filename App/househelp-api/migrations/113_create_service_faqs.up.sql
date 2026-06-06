-- 113_create_service_faqs.up.sql
-- Service Catalog Rework — STEP 2 of 4 (content seed), part 1: schema.
--
-- Adds a per-service FAQ table. `faq_items` (006) is global (no service_id) and
-- stays the home for the two truly-global FAQs (pro-safety, price). Per-service
-- FAQs (the supplies line for each service, plus the Pre/Post Party price
-- override) need a service-keyed home. This mirrors the existing per-service
-- content tables from migration 011 (service_includes / service_excludes /
-- service_steps).
--
-- DDL only — the rows are seeded in 114.

CREATE TABLE IF NOT EXISTS service_faqs (
    id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id    UUID    NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    question      TEXT    NOT NULL,
    answer        TEXT    NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (service_id, display_order)
);
CREATE INDEX IF NOT EXISTS idx_service_faqs_service_id ON service_faqs (service_id);
