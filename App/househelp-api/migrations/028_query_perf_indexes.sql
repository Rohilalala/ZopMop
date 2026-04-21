-- ─────────────────────────────────────────────────────────────────────────────
-- 028: Query performance indexes for high-traffic read paths
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_bookings_customer_created_at_desc
    ON bookings (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_status_created_at_desc
    ON bookings (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_name_user_created
    ON analytics_events (event_name, user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
