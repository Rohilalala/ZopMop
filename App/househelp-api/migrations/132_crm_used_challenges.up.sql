-- CRM auth bug fix: the TOTP challenge token was a stateless JWT, replayable
-- until its 5-minute exp. Each replay (with a still-valid TOTP code) minted a
-- brand-new session. This table records each consumed challenge jti so a
-- challenge can yield exactly one session; VerifyTOTPAndIssue inserts the jti
-- atomically before creating the session and rejects a duplicate.
CREATE TABLE IF NOT EXISTS crm_used_challenges (
  jti         UUID PRIMARY KEY,
  admin_id    UUID NOT NULL REFERENCES crm_admins(id) ON DELETE CASCADE,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Lets the expired-row sweep prune consumed challenges once past their TTL.
CREATE INDEX IF NOT EXISTS idx_crm_used_challenges_expires
  ON crm_used_challenges (expires_at);
