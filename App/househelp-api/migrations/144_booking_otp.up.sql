-- 144_booking_otp.up.sql
-- Server-side booking OTPs. START + END are 4-digit plaintext codes scoped to
-- one booking. Generated DB-side via a CSPRNG (pgcrypto gen_random_bytes) so a
-- single volatile column DEFAULT covers every insert path (CreateBooking,
-- CreateScheduledBooking, assigner force-assign) AND backfills existing rows
-- with a distinct code — no NULL-OTP gap, no predictable random() sequence.
-- 4 random bytes → 32-bit int → mod 10000 (modulo bias is negligible across
-- 2^32). Forward-only (repo policy).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS start_otp           VARCHAR(4)  NOT NULL DEFAULT lpad((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 10000)::text, 4, '0'),
    ADD COLUMN IF NOT EXISTS end_otp             VARCHAR(4)  NOT NULL DEFAULT lpad((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 10000)::text, 4, '0'),
    ADD COLUMN IF NOT EXISTS start_otp_attempts  INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS end_otp_attempts    INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS start_verified_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS end_verified_at     TIMESTAMPTZ;
