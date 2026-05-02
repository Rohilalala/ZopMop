-- 038_booking_arrived_at.sql
-- Marks the moment the assigned pro tapped "I've Arrived" at the customer's
-- location. Distinct from `accepted_at` (helper accepted the job) and the
-- transition to `in_progress` (job actually started). Drives the
-- "Pro's at your door" state on the customer's BookingConfirmed screen.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
