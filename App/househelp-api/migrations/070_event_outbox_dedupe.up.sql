-- 070_event_outbox_dedupe.sql
-- Belt-and-suspenders against duplicate booking.paid / wallet.topped_up
-- emissions. The transactional outbox pattern (ConsumeOnceTx + tx-bound
-- ledger / outbox writes) prevents double-emission under correct code,
-- but a future bug that bypasses the tx primitive must NOT silently
-- corrupt downstream consumers. This unique index turns such bugs into
-- a noisy unique-violation error at commit time, which is recoverable
-- (the webhook retries) instead of silent data divergence.
--
-- Scope: only the two payment-driven event types that carry a payment_id.
-- Other event types (booking.cancelled, helper.matched, …) can have many
-- rows per aggregate without uniqueness restrictions.
--
-- Functional index requires the JSON path to evaluate to NOT NULL for the
-- index entry to exist; the WHERE clause additionally filters on the
-- event_type. Both must hold for a row to participate in uniqueness.

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_outbox_payment_dedupe
  ON event_outbox ((payload->>'payment_id'))
  WHERE event_type IN ('booking.paid', 'wallet.topped_up')
    AND payload ? 'payment_id';
