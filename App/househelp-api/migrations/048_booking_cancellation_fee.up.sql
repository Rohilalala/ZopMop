-- 048_booking_cancellation_fee.sql
-- Track whether a cancellation incurred a fee. The fee window is computed
-- from scheduled_time (or created_at for instant bookings) — a cancellation
-- inside the protected window flips cancellation_fee_applied = TRUE and stamps
-- the charged amount in cents.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancellation_fee_applied BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancellation_fee_cents   INTEGER NOT NULL DEFAULT 0;
