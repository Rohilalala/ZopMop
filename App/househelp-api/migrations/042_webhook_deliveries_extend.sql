-- 042_webhook_deliveries_extend.sql
-- Align crm_webhook_deliveries with the dispatcher contract.
-- Renames status_code -> response_status, response -> response_body
-- Adds duration_ms (capture timing) and retried_at (mark replays).

ALTER TABLE crm_webhook_deliveries RENAME COLUMN status_code TO response_status;
ALTER TABLE crm_webhook_deliveries RENAME COLUMN response    TO response_body;

ALTER TABLE crm_webhook_deliveries
    ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
    ADD COLUMN IF NOT EXISTS retried_at  TIMESTAMPTZ;

-- Lookup index for retry / dashboard "failed only" filter.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_failed
    ON crm_webhook_deliveries (webhook_id, succeeded, created_at DESC)
    WHERE succeeded = false;
