-- 127_wallet_tx_reference.sql
-- Idempotency key for wallet ledger writes. The wallet-path refund credit
-- (crm/refunds runGateway) had no dedupe: when Credit committed but the
-- response was lost the refund row stayed 'gateway_error', and an admin
-- /retry re-ran the credit — paying the customer twice. The gateway path
-- already dedupes on the refund UUID (Cashfree idempotency key); the wallet
-- path now matches by stamping the refund id here and refusing a second
-- insert with the same reference.
--
-- Nullable + partial unique index so all existing ledger writes (topup,
-- spend, referral credits, sweeper reversals) that carry no reference are
-- unaffected — only referenced rows are deduped.

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS reference TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_reference
  ON wallet_transactions (reference)
  WHERE reference IS NOT NULL;
