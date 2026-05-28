-- 112_otp_payment_gates.up.sql
--
-- Phase 1 Step 1: add the four bookings columns that back the two-OTP
-- payment-gated service flow.
--
-- Background — see the audit in conversation log. The two-OTP flow gates
-- accepted->in_progress on a Start OTP and in_progress->completed on an End
-- OTP plus payment-resolution (Cashfree webhook 'paid' OR pro-marked cash).
-- The OTP codes themselves live in Redis (internal/otp); the columns added
-- here record the *verification* timestamps and the cash-collection event so
-- the booking row tells a complete story without consulting Redis.
--
-- Columns:
--
--   start_otp_verified_at  — stamped at StartBooking when the pro submits
--                            the correct start OTP; null until verified.
--   end_otp_verified_at    — stamped at CompleteBooking when the pro
--                            submits the correct end OTP; null until verified.
--   cash_collected_by_pro  — pro user_id who marked the booking paid by
--                            cash. Null when the customer paid via Cashfree
--                            or has not yet paid.
--   cash_collected_at      — when the pro tapped "paid by cash". Null
--                            unless the cash path was taken.
--
-- The two cash columns are deliberately NOT a separate ledger table at this
-- step. Step 3 builds the CRM "owes per pro" query against (cash_collected_by_pro,
-- cash_collected_at) plus a settled flag added there. Keeping cash data on
-- the booking row at this step minimizes the surface for the OTP-gate work.
--
-- Pro payroll is NOT touched here. The payroll engine (internal/payroll) is
-- a function of online/working minutes only; cash collection is an
-- orthogonal financial event the pro owes the company.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS start_otp_verified_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS end_otp_verified_at   TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS cash_collected_by_pro UUID        NULL REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS cash_collected_at     TIMESTAMPTZ NULL;

-- Index supports the CRM "owes per pro" query in Step 3: filter on
-- cash_collected_by_pro IS NOT NULL AND not-yet-settled (settled flag is
-- added by the Step 3 migration). Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_bookings_cash_collected_by_pro
    ON bookings (cash_collected_by_pro, cash_collected_at)
    WHERE cash_collected_by_pro IS NOT NULL;
