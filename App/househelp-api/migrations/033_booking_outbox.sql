CREATE TABLE IF NOT EXISTS booking_outbox (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type    TEXT NOT NULL,
    payload       JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempt_count INT NOT NULL DEFAULT 0,
    available_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_outbox_pending_scan
    ON booking_outbox (status, available_at, created_at)
    WHERE status IN ('pending', 'processing');
