-- LB-6: payment-intent double-charge guard.
--
-- POST /payments/cashfree/order does findReusableCashfreeOrder → already-paid
-- check → openCashfreeOrder (which INSERTs a pending payments row, then calls
-- the gateway). None of that is atomic, so two concurrent taps both miss the
-- reuse + already-paid checks and create TWO pending Cashfree orders → the
-- customer can be charged twice.
--
-- A partial unique index makes the second concurrent INSERT lose at the
-- payments row (before any gateway call), and the handler then reuses the
-- winner's order. Only ONE live pending Cashfree order can exist per booking.
--
-- Forward-only: first resolve any pre-existing duplicate pending rows (keep the
-- most recent per booking, mark the rest 'failed') so the unique index builds.
-- 'failed' is a valid gateway_status (CHECK in 056_payments.sql).

UPDATE payments SET gateway_status = 'failed'
WHERE id IN (
    SELECT id FROM (
        SELECT id,
               row_number() OVER (PARTITION BY booking_id ORDER BY created_at DESC) AS rn
        FROM payments
        WHERE booking_id IS NOT NULL
          AND gateway = 'cashfree'
          AND gateway_status = 'pending'
    ) ranked
    WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_pending_cashfree_per_booking
    ON payments (booking_id)
    WHERE booking_id IS NOT NULL
      AND gateway = 'cashfree'
      AND gateway_status = 'pending';
