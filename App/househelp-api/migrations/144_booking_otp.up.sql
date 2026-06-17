-- 144_booking_otp.up.sql
-- Server-side booking OTPs. START + END are 4-digit plaintext codes scoped to
-- one booking. The volatile random() DEFAULT means Postgres evaluates a fresh
-- value PER ROW: this both backfills every existing row with a distinct code
-- and auto-generates for every future INSERT regardless of code path
-- (CreateBooking, CreateScheduledBooking, assigner force-assign). Forward-only.
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS start_otp           VARCHAR(4)  NOT NULL DEFAULT (lpad((floor(random()*10000))::text, 4, '0')),
    ADD COLUMN IF NOT EXISTS end_otp             VARCHAR(4)  NOT NULL DEFAULT (lpad((floor(random()*10000))::text, 4, '0')),
    ADD COLUMN IF NOT EXISTS start_otp_attempts  INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS end_otp_attempts    INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS start_verified_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS end_verified_at     TIMESTAMPTZ;
