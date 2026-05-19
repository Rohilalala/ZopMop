-- 101_job_lifecycle.sql
-- Phase 10 — Job lifecycle: per-service task progress + bookings earnings
-- snapshot + status enum extension.
--
-- Forward-only per repo policy. No .down.sql.

-- ─── booking_services — per-service task progress ───────────────────
-- A booking can have multiple service line items. The pro who accepts
-- the booking handles them all sequentially; this lets them mark each
-- one done as they work through the checklist.
ALTER TABLE booking_services
    ADD COLUMN IF NOT EXISTS status       VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
    ADD COLUMN IF NOT EXISTS started_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS skip_reason  TEXT;

-- Index for pro-app job detail screen which loads every service row
-- for a booking ordered by display_order.
CREATE INDEX IF NOT EXISTS idx_booking_services_order
    ON booking_services (booking_id, display_order);

-- ─── bookings — earnings snapshot + en-route timestamp + rating flag ───
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS en_route_at              TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pro_earnings_paise       BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS actual_duration_minutes  INT,
    ADD COLUMN IF NOT EXISTS customer_rating_pending  BOOLEAN NOT NULL DEFAULT false;

-- ─── status enum extension ──────────────────────────────────────────
-- Drop + re-add CHECK with new values. Existing rows untouched —
-- nothing in production should currently hold the new values so the
-- constraint passes cleanly.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE bookings
    ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
        'pending',
        'searching',
        'dispatching',
        'accepted',
        'arrived',
        'in_progress',
        'completed',
        'cancelled',
        'pending_customer_action',
        'no_pro_available',
        'no_show'
    ));

-- ─── flip customer_rating_pending for already-completed bookings ────
-- Past completed bookings that have no review row yet should show up
-- as ratable; bookings that already have a review should not.
UPDATE bookings b
   SET customer_rating_pending = true
 WHERE status = 'completed'
   AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id);
