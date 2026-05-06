-- 067_wallets.sql
-- Closed-loop wallet for Zopmop bookings. Funds are spendable only on
-- bookings on this platform — no P2P transfers, no withdrawal to bank, no
-- third-party payments. This semantic is enforced in the wallet service
-- (kind enum below + service-layer validation), keeping us outside RBI PPI
-- licensing scope.
--
-- Two tables:
--   wallets              — one row per user, current balance
--   wallet_transactions  — append-only ledger of every credit/debit, for
--                          audit + history UI

CREATE TABLE IF NOT EXISTS wallets (
  user_id        UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_paise  BIGINT       NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_paise   BIGINT       NOT NULL,                    -- positive = credit, negative = debit
  balance_after  BIGINT       NOT NULL,                    -- snapshot for audit
  kind           TEXT         NOT NULL CHECK (kind IN
                              ('topup','spend','refund_credit','adjustment','reversal')),
  booking_id     UUID         REFERENCES bookings(id),     -- nullable; required at service layer for kind='spend'
  payment_id     UUID         REFERENCES payments(id),     -- nullable; required at service layer for kind='topup'
  note           TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user
  ON wallet_transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_booking
  ON wallet_transactions (booking_id)
  WHERE booking_id IS NOT NULL;
