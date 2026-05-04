-- 059_user_segment.sql
-- Adds the segment column to users. Populated by the segments worker
-- (internal/segments) on a 24h cadence. CRM users module reads this column
-- as-is — no derivation logic on the read path.
--
-- Allowed values:
--   NEW       — zero completed bookings ever
--   RETURNING — booked within the last 15 days
--   AT_RISK   — last booking 15-30 days ago
--   CHURNED   — last booking older than 30 days

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS segment TEXT NOT NULL DEFAULT 'NEW'
    CHECK (segment IN ('NEW','RETURNING','AT_RISK','CHURNED'));

CREATE INDEX IF NOT EXISTS idx_users_segment ON users (segment) WHERE deleted_at IS NULL;
