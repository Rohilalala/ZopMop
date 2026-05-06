-- 057_processed_webhook_events.up.sql
-- Idempotency table for inbound payment-gateway webhooks.
-- Insert keyed on the gateway's event_id after the handler finishes; subsequent
-- deliveries of the same event short-circuit on the existence check.

CREATE TABLE IF NOT EXISTS processed_webhook_events (
    event_id     TEXT        PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
