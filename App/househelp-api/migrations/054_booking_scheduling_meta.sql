-- 054_booking_scheduling_meta.sql
-- Scheduled-booking dispatch metadata.
--
-- Columns:
--   is_stealth_instant              — booking placed after 8pm IST cutoff;
--                                     handled by stealth dispatch cron, not
--                                     the nightly 10pm cron.
--   fire_at                         — when stealth dispatch should kick off
--                                     the invite chain (= scheduled_time -
--                                     15 minutes for stealth bookings).
--   invite_exhausted_at             — set when the invite chain ran out of
--                                     pros to ask. Drives the 2h rebook
--                                     scanner window.
--   preferred_helper_chain_exhausted — true once Phase 1 (preferred pros)
--                                     has been fully tried. Lets a resumed
--                                     dispatch skip straight to Phase 2.
--   locality                        — snapshot of the booking's locality at
--                                     create time. Fuzzy-matched against
--                                     localities.name from the address line
--                                     so a later locality rename doesn't
--                                     orphan in-flight bookings.
--   rebook_pushed_at                — set the first time the rebook-available
--                                     scanner pushes the customer a "pros
--                                     are now available" notification. Used
--                                     to enforce one-shot delivery per
--                                     cancelled booking.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS is_stealth_instant               BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS fire_at                          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS invite_exhausted_at              TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS preferred_helper_chain_exhausted BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS locality                         TEXT,
    ADD COLUMN IF NOT EXISTS rebook_pushed_at                 TIMESTAMPTZ;

-- Index for the stealth dispatch cron's "ready to fire" query.
CREATE INDEX IF NOT EXISTS idx_bookings_stealth_fire
    ON bookings (fire_at)
    WHERE is_stealth_instant = true AND status = 'pending';

-- Index for the nightly cron's "needs dispatch" query.
CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_pending
    ON bookings (scheduled_time)
    WHERE status = 'pending'
      AND helper_id IS NULL
      AND is_stealth_instant = false
      AND scheduled_time IS NOT NULL;

-- Index for the rebook scanner's "recently exhausted" query.
CREATE INDEX IF NOT EXISTS idx_bookings_invite_exhausted_unpushed
    ON bookings (invite_exhausted_at)
    WHERE invite_exhausted_at IS NOT NULL
      AND rebook_pushed_at IS NULL
      AND status = 'cancelled';

-- Status enum extension: 'searching' (stealth dispatch actively asking pros)
-- and 'pending_customer_action' (15-min stealth window expired without an
-- acceptance, customer must Keep Looking or Cancel). Drop the old constraint
-- and re-add with the new value set.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE bookings
    ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
        'pending',
        'accepted',
        'in_progress',
        'completed',
        'cancelled',
        'searching',
        'pending_customer_action',
        'arrived'
    ));
