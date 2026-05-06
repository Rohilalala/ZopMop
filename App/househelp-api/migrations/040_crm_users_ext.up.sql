-- 040_crm_users_ext.sql
-- CRM extension columns on the shared users table + per-user note storage.
-- Kept here (not in 039) because these touch a non-CRM table; rolling back
-- 040 doesn't break the CRM core schema.

-- Optional admin-set fields that don't fit the user-app's model.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email          CITEXT,
  ADD COLUMN IF NOT EXISTS avatar_url     TEXT,
  ADD COLUMN IF NOT EXISTS is_vip         BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suspend_reason TEXT,
  ADD COLUMN IF NOT EXISTS banned_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ban_reason     TEXT;

-- Email uniqueness is enforced only when a value is present so existing
-- phone-only accounts don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users (email) WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_vip
  ON users (is_vip) WHERE is_vip;

CREATE INDEX IF NOT EXISTS idx_users_banned
  ON users (banned_at) WHERE banned_at IS NOT NULL;

-- Per-user notes from admins. Not part of crm_audit_log because notes are
-- editable in their own right and have no before/after diff semantics.
CREATE TABLE IF NOT EXISTS crm_user_notes (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_id    UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  admin_email TEXT,
  body        TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_user_notes_user
  ON crm_user_notes (user_id, created_at DESC);
