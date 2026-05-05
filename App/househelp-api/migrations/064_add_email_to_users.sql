-- 064_add_email_to_users.sql
-- Adds an optional email column to users. Cashfree PG order creation requires
-- a customer_email; when null we synthesise <userID>@noemail.zopmop.local at
-- the call boundary (see internal/payments/cashfree.go). Email is not used as
-- a login identifier — phone+OTP remains the sole auth path.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT;

CREATE INDEX IF NOT EXISTS idx_users_email
  ON users (email)
  WHERE email IS NOT NULL;
