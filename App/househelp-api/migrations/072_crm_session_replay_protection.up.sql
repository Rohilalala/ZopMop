-- 072_crm_session_replay_protection.sql
-- Audit C-2 / A1-F1 (RFC 6819 §5.2.2): refresh-token replay detection.
--
-- Before this migration, RotateSession did an in-place UPDATE on
-- crm_admin_sessions, overwriting the previous refresh_token_hash. There
-- was no record that "old hash X was used and rotated to new hash Y", so
-- a stolen refresh cookie replayed by an attacker could not be detected
-- — the legitimate user just got silently logged out at next refresh.
--
-- After this migration, each rotation INSERTs a new row in the same
-- "family" (family_id) and stamps the old row with rotated_at + rotated_to.
-- A subsequent presentation of an already-rotated hash is treated as a
-- replay attempt: the entire family is revoked (revoked_at + replay_
-- detected_at) and an audit row is written. A 5-second grace window in
-- the service layer absorbs the genuine retry/network-flake case.

ALTER TABLE crm_admin_sessions
    ADD COLUMN IF NOT EXISTS family_id          UUID,
    ADD COLUMN IF NOT EXISTS rotated_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rotated_to         UUID REFERENCES crm_admin_sessions(id),
    ADD COLUMN IF NOT EXISTS replay_detected_at TIMESTAMPTZ;

-- Backfill: every existing session is its own one-element family. Safe
-- to run multiple times (only nulls update).
UPDATE crm_admin_sessions
SET family_id = id
WHERE family_id IS NULL;

-- Once backfill is complete, family_id is required for new rows; new
-- sessions get a fresh UUID via the default. Wrap in DO blocks so the
-- migration is idempotent across re-runs.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'crm_admin_sessions'
          AND column_name = 'family_id'
          AND is_nullable = 'YES'
    ) THEN
        ALTER TABLE crm_admin_sessions ALTER COLUMN family_id SET NOT NULL;
    END IF;
END$$;

ALTER TABLE crm_admin_sessions
    ALTER COLUMN family_id SET DEFAULT gen_random_uuid();

-- Fast family-walk for revocation. Only live rows participate in the
-- "is the family compromised" check, so a partial index is enough.
CREATE INDEX IF NOT EXISTS idx_crm_admin_sessions_family_active
    ON crm_admin_sessions (family_id)
    WHERE revoked_at IS NULL;
