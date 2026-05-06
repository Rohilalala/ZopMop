-- 045_push_status_extras.sql
-- Adds the bits the scheduled-push cron + cancel/retry endpoints need:
--   * error_message — populated when SendPush (or the cron) marks a row 'failed'.
--     Optional; null on success.
--   * 'cancelled' status — set by the new POST /growth/push/:id/cancel
--     endpoint. The cron skips anything that isn't 'scheduled'.
--
-- The migration drops + recreates the status CHECK constraint so the new
-- value is allowed. CHECK constraint names follow the implicit Postgres
-- naming (table_column_check) — verified against migration 041's DDL.

ALTER TABLE crm_push_messages
    ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE crm_push_messages
    DROP CONSTRAINT IF EXISTS crm_push_messages_status_check;

ALTER TABLE crm_push_messages
    ADD CONSTRAINT crm_push_messages_status_check
    CHECK (status IN ('draft','scheduled','sent','failed','cancelled'));
