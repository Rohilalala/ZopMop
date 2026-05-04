-- 056_payments.sql
-- Charge ledger for the user-app. Until now `bookings.price_cents` was the
-- only record of money owed; there was no row representing the actual gateway
-- transaction. CRM integrity checks (sum reconciliation, duplicate gateway
-- ref detection, webhook landing) need a per-charge ledger.
--
-- One row per intent. Created at booking confirmation in 'pending' state and
-- moved to 'success' / 'failed' when the gateway webhook lands. COD bookings
-- get a row too, with gateway='cod', so order count == payment count.

CREATE TABLE IF NOT EXISTS payments (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           UUID         NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id              UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_paise         BIGINT       NOT NULL CHECK (amount_paise >= 0),
  currency             TEXT         NOT NULL DEFAULT 'INR',
  gateway              TEXT         NOT NULL,
  gateway_ref          TEXT         UNIQUE,
  gateway_status       TEXT         NOT NULL DEFAULT 'pending'
                                    CHECK (gateway_status IN ('pending','success','failed','refunded')),
  webhook_received_at  TIMESTAMPTZ,
  reconciled           BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments (booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (gateway_status, created_at DESC);
