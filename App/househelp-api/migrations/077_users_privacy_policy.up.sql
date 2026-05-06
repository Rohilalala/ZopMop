-- 077_users_privacy_policy.up.sql
-- Capture explicit Terms of Service / Privacy Policy acceptance at first sign-up.
-- Existing rows backfill to TRUE so legacy users (who accepted under the prior
-- click-through Terms link on PhoneEntry) are not blocked. New rows default to
-- FALSE; the verify-OTP path stamps it once the user ticks the checkbox.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS has_accepted_privacy_policy BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS privacy_policy_accepted_at  TIMESTAMPTZ;

UPDATE users
   SET has_accepted_privacy_policy = TRUE,
       privacy_policy_accepted_at  = COALESCE(privacy_policy_accepted_at, created_at)
 WHERE has_accepted_privacy_policy = FALSE;
