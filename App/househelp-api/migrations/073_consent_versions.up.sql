-- 073_consent_versions.sql
-- Self-heal: ensure the privacy_policy columns exist before the backfill
-- below references them. Original ordering bug: this migration referenced
-- users.privacy_policy_accepted_at before migration 077 added it, so a
-- fresh DB applying migrations in numerical order failed at 073 with
-- "column does not exist". ADD COLUMN IF NOT EXISTS makes both this
-- migration and 077 idempotent regardless of which ran first.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS has_accepted_privacy_policy BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS privacy_policy_accepted_at  TIMESTAMPTZ;

-- Audit C-8 / F2D-1, CH1D-11: replace the single boolean
-- users.has_accepted_privacy_policy with a versioned, per-purpose
-- consent ledger. The boolean stays in place for now (read-compat); a
-- later migration drops it once the new system is live and the user-app
-- writes to user_consents on every accept / withdraw.
--
-- Backfill caveat: existing rows with has_accepted_privacy_policy=TRUE
-- are seeded into user_consents at granted_at = privacy_policy_accepted_at
-- (or created_at). This preserves the (already-flagged) retroactive
-- consent state — does not retroactively obtain consent. The audit
-- finding CH1D-11 (DPDP §6 affirmative-act violation) remains open and
-- is tracked separately; this migration keeps the existing posture
-- without making it worse.

CREATE TABLE IF NOT EXISTS consent_versions (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    document_type   VARCHAR(50)  NOT NULL,    -- 'privacy_policy' | 'terms' | 'marketing' | future
    version         VARCHAR(20)  NOT NULL,
    effective_from  TIMESTAMPTZ  NOT NULL,
    content_url     TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (document_type, version)
);

CREATE TABLE IF NOT EXISTS user_consents (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    consent_version_id  UUID         NOT NULL REFERENCES consent_versions(id),
    granted_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    withdrawn_at        TIMESTAMPTZ,
    ip_address          INET,
    user_agent          TEXT,
    UNIQUE (user_id, consent_version_id)
);

CREATE INDEX IF NOT EXISTS idx_user_consents_active
    ON user_consents (user_id, consent_version_id)
    WHERE withdrawn_at IS NULL;

-- Seed the existing privacy policy as v1.0 if not present.
INSERT INTO consent_versions (document_type, version, effective_from)
VALUES ('privacy_policy', '1.0', '2025-01-01T00:00:00Z')
ON CONFLICT (document_type, version) DO NOTHING;

-- Backfill existing accept-state into the new ledger. Idempotent via the
-- UNIQUE (user_id, consent_version_id) constraint.
INSERT INTO user_consents (user_id, consent_version_id, granted_at)
SELECT u.id,
       cv.id,
       COALESCE(u.privacy_policy_accepted_at, u.created_at)
FROM   users u
CROSS JOIN consent_versions cv
WHERE  u.has_accepted_privacy_policy = TRUE
  AND  cv.document_type = 'privacy_policy'
  AND  cv.version       = '1.0'
ON CONFLICT (user_id, consent_version_id) DO NOTHING;
