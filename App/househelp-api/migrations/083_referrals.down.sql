-- Reverse 083_referrals.up.sql
DROP TABLE IF EXISTS referrals;

ALTER TABLE users DROP COLUMN IF EXISTS referral_code;

-- Restore original wallet_transactions kind CHECK (without referral_credit).
ALTER TABLE wallet_transactions
  DROP CONSTRAINT wallet_transactions_kind_check,
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN ('topup','spend','refund_credit','adjustment','reversal'));
