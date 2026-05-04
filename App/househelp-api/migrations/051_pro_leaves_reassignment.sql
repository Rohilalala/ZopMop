-- 051_pro_leaves_reassignment.sql
-- Operational outcome of a declared leave: how many bookings were impacted,
-- whether they were reassigned, and the IDs of any that had to be cancelled
-- because no replacement pro was available. Surfaced on the CRM leaves page.
ALTER TABLE pro_leaves
    ADD COLUMN IF NOT EXISTS bookings_affected     INTEGER     NOT NULL DEFAULT 0,
    -- 'reassigned' | 'partially_reassigned' | 'cancelled' | 'none' (when no bookings touched)
    ADD COLUMN IF NOT EXISTS reassignment_outcome  TEXT        NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS cancelled_booking_ids UUID[]      NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_pro_leaves_outcome_cancelled
    ON pro_leaves (reassignment_outcome)
    WHERE reassignment_outcome = 'cancelled';
