-- 083_referrals.up.sql
-- Referral system: name-based codes on users, referral tracking table.
-- Reward rules: both credits fire on referee's first post-referral completed booking.

-- 1. Referral code per user (name-based, UNIQUE, permanently locked once set).
ALTER TABLE users ADD COLUMN referral_code TEXT UNIQUE;

-- 2. Referrals tracking.
CREATE TABLE referrals (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id          UUID        NOT NULL REFERENCES users(id),
  referee_id           UUID        NOT NULL REFERENCES users(id),
  status               TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'completed')),
  referee_credited_at  TIMESTAMPTZ,
  referrer_credited_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(referee_id)               -- a user can only be referred once
);

CREATE INDEX referrals_referrer_idx ON referrals(referrer_id, status);

-- 3. Extend wallet_transactions.kind CHECK to include referral_credit.
ALTER TABLE wallet_transactions
  DROP CONSTRAINT wallet_transactions_kind_check;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
  CHECK (kind IN ('topup','spend','refund_credit','adjustment','reversal','referral_credit'));
