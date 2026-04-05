-- 020_add_fcm_tokens.sql
-- Add fcm_token column to users table for push notifications

ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token VARCHAR(255);

-- Index on fcm_token to quickly lookup user by device or prevent duplicate blasts if necessary
CREATE INDEX IF NOT EXISTS idx_users_fcm_token ON users(fcm_token) WHERE fcm_token IS NOT NULL;
