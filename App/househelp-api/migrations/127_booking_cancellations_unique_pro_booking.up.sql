-- Idempotency guard for the pro cancel endpoint.
--
-- POST /pro/bookings/:id/cancel had no idempotency: a double-tap or a
-- timeout-retry could insert a second strike row (and a second penalty)
-- for the same (pro, booking). The status-guarded UPDATE in
-- MarkBookingCancelled is the primary gate, but this unique index is
-- defense-in-depth so a stacked strike can never persist even under a
-- race.
--
-- Dedup any pre-existing duplicate rows first (keep the earliest), then
-- add the constraint. Forward-only per repo policy (no .down.sql).

DELETE FROM booking_cancellations bc
 USING booking_cancellations keep
 WHERE bc.pro_id = keep.pro_id
   AND bc.booking_id = keep.booking_id
   AND bc.created_at > keep.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_cancellations_pro_booking
    ON booking_cancellations (pro_id, booking_id);
