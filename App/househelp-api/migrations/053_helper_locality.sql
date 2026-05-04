-- 053_helper_locality.sql
-- Free-text locality on helpers, managed via CRM dropdown sourced from the
-- localities table (migration 055). No GPS validation — admin-trusted.

ALTER TABLE helpers
    ADD COLUMN IF NOT EXISTS locality TEXT;

CREATE INDEX IF NOT EXISTS idx_helpers_locality
    ON helpers (locality)
    WHERE locality IS NOT NULL;
