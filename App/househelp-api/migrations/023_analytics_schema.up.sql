-- ─────────────────────────────────────────────────────────────────────────────
-- 023: Analytics schema
-- Adds the analytics_events table for event tracking and timing columns to
-- the bookings table for operational metrics (time-to-assign, job duration).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Event store ───────────────────────────────────────────────────────────────
-- Append-only table. One row per tracked event.
-- user_id and booking_id are nullable foreign keys so orphan rows are kept
-- for historical analysis even if the referenced row is later deleted.
CREATE TABLE IF NOT EXISTS analytics_events (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name  TEXT        NOT NULL,
    user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
    booking_id  UUID        REFERENCES bookings(id) ON DELETE SET NULL,
    properties  JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Query patterns:
--   1. Time-range aggregations per event name (funnel, trends).
--   2. Per-user event history.
--   3. Per-booking event history.
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time
    ON analytics_events (event_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time
    ON analytics_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_booking
    ON analytics_events (booking_id)
    WHERE booking_id IS NOT NULL;

-- ── Booking timing columns ────────────────────────────────────────────────────
-- These power time-to-assign, response time, and job duration metrics.
-- Populated by the booking service as each lifecycle transition happens.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS accepted_at    TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS started_at     TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at   TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by   TEXT;   -- 'customer' | 'helper' | 'system'

-- Index to support the operational metrics query (completed bookings with timing).
CREATE INDEX IF NOT EXISTS idx_bookings_completed_timing
    ON bookings (completed_at DESC)
    WHERE status = 'completed';
