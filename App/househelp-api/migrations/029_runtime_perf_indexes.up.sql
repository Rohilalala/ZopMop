-- ─────────────────────────────────────────────────────────────────────────────
-- 029: Runtime performance indexes for booking list and analytics scans
-- ─────────────────────────────────────────────────────────────────────────────

-- Scheduled-booking feed: avoid ORDER BY COALESCE(...) full-sort behavior.
CREATE INDEX IF NOT EXISTS idx_bookings_customer_scheduled_time_desc
    ON bookings (customer_id, scheduled_time DESC)
    WHERE scheduled_time IS NOT NULL;

-- Helper performance rollups and helper-focused booking scans.
CREATE INDEX IF NOT EXISTS idx_bookings_helper_created_at_desc
    ON bookings (helper_id, created_at DESC)
    WHERE helper_id IS NOT NULL;

-- Fast pruning for append-only analytics event time ranges.
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at_brin
    ON analytics_events USING BRIN (created_at);

-- Support overview/new-users period lookups.
CREATE INDEX IF NOT EXISTS idx_users_created_at_desc
    ON users (created_at DESC);
