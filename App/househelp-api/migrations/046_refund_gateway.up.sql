-- 046_refund_gateway.sql
-- Track payment method + payment_id on bookings so refunds can route to the
-- right gateway. Extend pending_refunds with gateway tracking fields.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20),  -- 'cod' | 'upi' | 'card' | 'wallet' | 'netbanking' | NULL
    ADD COLUMN IF NOT EXISTS payment_id     VARCHAR(80),  -- gateway-specific payment reference (e.g. Razorpay payment_id pay_xxx)
    ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20);  -- 'pending' | 'paid' | 'failed' | 'refunded'

CREATE INDEX IF NOT EXISTS idx_bookings_payment_id ON bookings (payment_id) WHERE payment_id IS NOT NULL;

-- pending_refunds: add gateway tracking + status enum widening
ALTER TABLE pending_refunds
    ADD COLUMN IF NOT EXISTS booking_id        UUID REFERENCES bookings(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payment_method    VARCHAR(20),
    ADD COLUMN IF NOT EXISTS payment_id        VARCHAR(80),
    ADD COLUMN IF NOT EXISTS gateway_refund_id VARCHAR(80),
    ADD COLUMN IF NOT EXISTS approved_by       UUID REFERENCES crm_admins(id),
    ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS processed_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS error_message     TEXT,
    ADD COLUMN IF NOT EXISTS partial_amount_cents BIGINT;

-- Status values now legal: pending, approved, processed, processed_manual, gateway_error, rejected, cancelled
-- 034 created the table without an explicit CHECK on status, but a previous
-- partial deploy may have added one. Drop any pre-existing variant before
-- installing the wider one.
DO $$
DECLARE
    cname TEXT;
BEGIN
    FOR cname IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'pending_refunds'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
    LOOP
        EXECUTE format('ALTER TABLE pending_refunds DROP CONSTRAINT IF EXISTS %I', cname);
    END LOOP;
END $$;

ALTER TABLE pending_refunds
    ADD CONSTRAINT pending_refunds_status_check
    CHECK (status IN ('pending','approved','processed','processed_manual','gateway_error','rejected','cancelled'));

-- Index for "find duplicate refund on same booking"
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_refunds_booking_active
    ON pending_refunds (booking_id)
    WHERE booking_id IS NOT NULL AND status IN ('pending','approved','processed','processed_manual');
