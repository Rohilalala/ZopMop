-- 066_cashfree_orders.sql
-- Per-payment Cashfree order metadata. The existing payments table (056)
-- remains the universal ledger; this table holds gateway-specific fields
-- (cf_order_id, payment_session_id, expires_at) so the ledger stays clean
-- and a future second gateway can sit alongside without schema collisions.

CREATE TABLE IF NOT EXISTS cashfree_orders (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          UUID         NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  cf_order_id         TEXT         UNIQUE NOT NULL,   -- Cashfree's order id
  order_id            TEXT         UNIQUE NOT NULL,   -- our id, sent to CF as order_id
  payment_session_id  TEXT         NOT NULL,          -- consumed by the React Native SDK
  order_status        TEXT         NOT NULL DEFAULT 'ACTIVE',
  expires_at          TIMESTAMPTZ  NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cf_orders_payment ON cashfree_orders (payment_id);
