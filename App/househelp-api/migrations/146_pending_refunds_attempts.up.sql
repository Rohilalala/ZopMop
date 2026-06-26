-- 146_pending_refunds_attempts
-- Retry tracking for the cmd/api RefundWorker. A transient gateway failure marks
-- a row 'gateway_error'; the worker re-drives those with backoff (keyed off
-- approved_at) up to a capped number of attempts, instead of stranding the
-- refund until manual intervention.
ALTER TABLE pending_refunds
    ADD COLUMN IF NOT EXISTS refund_attempts INT NOT NULL DEFAULT 0;
