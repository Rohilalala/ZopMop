-- 071_cancel_orphan_pending.sql
-- Cleanup for the direct-pay leak that existed before this migration:
-- bookings with status='pending' and payment_method=NULL that were created
-- via the direct-pay flow but never reached payment confirmation. These
-- rows showed up in the customer's "upcoming" list as if they were real
-- scheduled bookings.
--
-- Going forward, direct-pay bookings are stamped payment_method='cashfree'
-- on creation and the customer-facing list filters them out until the
-- webhook stamps payment_status='paid'. This migration sweeps the orphans
-- left behind from the broken window.
--
-- Idempotent: re-running won't re-cancel anything (rows already cancelled
-- get filtered out by the status='pending' clause). The 5-minute age gate
-- protects against catching bookings still in their initial SDK flow.

UPDATE bookings
SET status = 'cancelled',
    cancelled_at = NOW(),
    cancelled_by = 'system',
    updated_at = NOW()
WHERE status = 'pending'
  AND payment_method IS NULL
  AND created_at < NOW() - INTERVAL '5 minutes';
