-- ─────────────────────────────────────────────────────────────────────────────
-- 030: Hourly/daily analytics rollups for runtime-read safety
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics_funnel_hourly (
    bucket_hour    TIMESTAMPTZ NOT NULL,
    event_name     TEXT        NOT NULL,
    distinct_users INTEGER     NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bucket_hour, event_name)
);

CREATE INDEX IF NOT EXISTS idx_analytics_funnel_hourly_event_hour
    ON analytics_funnel_hourly (event_name, bucket_hour DESC);

CREATE TABLE IF NOT EXISTS analytics_booking_kpi_hourly (
    bucket_hour               TIMESTAMPTZ NOT NULL PRIMARY KEY,
    total_bookings            INTEGER     NOT NULL DEFAULT 0,
    completed_bookings        INTEGER     NOT NULL DEFAULT 0,
    cancelled_bookings        INTEGER     NOT NULL DEFAULT 0,
    pending_bookings          INTEGER     NOT NULL DEFAULT 0,
    matched_bookings          INTEGER     NOT NULL DEFAULT 0,
    started_bookings          INTEGER     NOT NULL DEFAULT 0,
    auto_expired_bookings     INTEGER     NOT NULL DEFAULT 0,
    total_match_attempts      BIGINT      NOT NULL DEFAULT 0,
    revenue_gross_cents       BIGINT      NOT NULL DEFAULT 0,
    revenue_discount_cents    BIGINT      NOT NULL DEFAULT 0,
    revenue_net_cents         BIGINT      NOT NULL DEFAULT 0,
    assign_seconds_sum        DOUBLE PRECISION NOT NULL DEFAULT 0,
    assign_seconds_samples    INTEGER     NOT NULL DEFAULT 0,
    job_minutes_sum           DOUBLE PRECISION NOT NULL DEFAULT 0,
    job_minutes_samples       INTEGER     NOT NULL DEFAULT 0,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_booking_kpi_hourly_bucket
    ON analytics_booking_kpi_hourly (bucket_hour DESC);

CREATE TABLE IF NOT EXISTS analytics_helper_daily (
    bucket_date               DATE        NOT NULL,
    helper_id                 UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    total_assigned            INTEGER     NOT NULL DEFAULT 0,
    total_completed           INTEGER     NOT NULL DEFAULT 0,
    total_cancelled           INTEGER     NOT NULL DEFAULT 0,
    response_seconds_sum      DOUBLE PRECISION NOT NULL DEFAULT 0,
    response_seconds_samples  INTEGER     NOT NULL DEFAULT 0,
    job_minutes_sum           DOUBLE PRECISION NOT NULL DEFAULT 0,
    job_minutes_samples       INTEGER     NOT NULL DEFAULT 0,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bucket_date, helper_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_helper_daily_helper_date
    ON analytics_helper_daily (helper_id, bucket_date DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_helper_daily_bucket_date
    ON analytics_helper_daily (bucket_date DESC);
