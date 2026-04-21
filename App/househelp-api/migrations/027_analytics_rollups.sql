-- ─────────────────────────────────────────────────────────────────────────────
-- 027: Analytics rollup table for distinct user/event/day entries
-- Reduces scan volume for funnel queries that need distinct users over time windows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics_event_user_daily (
    event_date DATE NOT NULL,
    event_name TEXT NOT NULL,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_date, event_name, user_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_event_user_daily_name_date
    ON analytics_event_user_daily (event_name, event_date DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_event_user_daily_date
    ON analytics_event_user_daily (event_date DESC);
