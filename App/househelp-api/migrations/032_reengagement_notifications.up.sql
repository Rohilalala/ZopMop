CREATE TABLE IF NOT EXISTS reengagement_notifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario      TEXT NOT NULL,
    window_start  TIMESTAMPTZ NOT NULL,
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reengagement_user_scenario_window
    ON reengagement_notifications (user_id, scenario, window_start);

CREATE INDEX IF NOT EXISTS idx_reengagement_sent_at
    ON reengagement_notifications (sent_at DESC);
