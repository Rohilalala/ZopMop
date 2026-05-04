-- 049_crm_notifications.sql
-- CRM notification centre. Distinct from `crm_alerts` (which is the legacy
-- system-feed dashboard widget): notifications are addressed to admins, can be
-- marked read individually, and carry a typed link to the originating record.
CREATE TABLE IF NOT EXISTS crm_notifications (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT        NOT NULL,
    body        TEXT        NOT NULL DEFAULT '',
    severity    TEXT        NOT NULL CHECK (severity IN ('info', 'warning', 'urgent')),
    entity_type TEXT,
    entity_id   TEXT,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_notifications_unread_recent
    ON crm_notifications (created_at DESC)
    WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_crm_notifications_recent
    ON crm_notifications (created_at DESC);
