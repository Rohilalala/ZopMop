-- 097_msg91_auth.up.sql
--
-- Schema support for the MSG91-backed OTP login + self-issued
-- access/refresh JWT pair that replaces Firebase Phone Auth.
--
-- Two changes, both idempotent:
--
--   1. users.phone_verified_at — timestamp of the most recent
--      successful MSG91 OTP verification for this account. Used to
--      gate any future flow that needs proof of recent verification
--      (e.g. payout setup, sensitive profile edits). NULL means
--      "never verified" — present rows that came in via the old
--      Firebase flow keep NULL until next login. The decision was
--      to leave users + helpers schema intact and derive
--      user_type from users.role, so phone_verified_at lives on
--      users only (pros are users.role='pro' with a helpers row).
--
--   2. refresh_tokens — one row per refresh-token issuance.
--      token_hash is sha256-hex of the opaque token returned to the
--      client (the plaintext is NEVER stored). user_type is the
--      JWT typ claim at issuance time so /refresh can re-mint with
--      the same typ without an extra users lookup. revoked_at is
--      stamped on logout AND on rotation — the prior token is
--      single-use.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_type     VARCHAR(16) NOT NULL CHECK (user_type IN ('customer', 'pro')),
    token_hash    CHAR(64)    NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ
);

-- Hash is the lookup key on every /refresh + /logout call. UNIQUE
-- protects against collisions and lets us upsert on rotation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash
    ON refresh_tokens (token_hash);

-- Per-user sweep used by /me/sessions and the nightly purge job.
-- Partial index excludes already-revoked and already-expired rows so
-- the index stays small even after months of churn.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
    ON refresh_tokens (user_id)
    WHERE revoked_at IS NULL;

-- Nightly purge: DELETE FROM refresh_tokens WHERE expires_at < now()
-- - INTERVAL '7 days'. Index supports the range scan.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
    ON refresh_tokens (expires_at);
