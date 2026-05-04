-- 044_push_send_stats.sql
-- Track per-push delivery outcomes for the CRM push composer history view.
-- sent_count    = number of FCM tokens we attempted to send to.
-- delivered_count = FCM SuccessCount summed across batches.
-- failed_count  = FCM FailureCount summed across batches.

ALTER TABLE crm_push_messages
    ADD COLUMN IF NOT EXISTS sent_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS delivered_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failed_count    INTEGER NOT NULL DEFAULT 0;
