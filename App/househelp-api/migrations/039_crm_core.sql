-- 039_crm_core.sql
-- Core CRM v2 tables. Fully isolated from existing admin_users / admin_action_log
-- (those serve the legacy /api/v1/admin surface and the user-app's pro flows).
-- The new CRM (crm.zopmop.com, separate Go binary, separate JWT) reads/writes
-- ONLY the crm_* tables defined here plus shared business tables (users,
-- bookings, etc) via its own connection pool.

-- ─────────────────────────────────────────────────────────────────────────────
-- crm_admins: people who can log into the CRM. Independent of users.
-- Auth = email + password (argon2id) + mandatory TOTP. No SSO, no oauth.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_admins (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email              CITEXT      NOT NULL UNIQUE,
  password_hash      TEXT        NOT NULL,
  display_name       TEXT        NOT NULL,
  avatar_url         TEXT,
  role               TEXT        NOT NULL DEFAULT 'admin'
                                 CHECK (role IN ('superadmin', 'admin', 'support', 'viewer')),
  permissions        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  totp_secret        TEXT,
  totp_enrolled_at   TIMESTAMPTZ,
  failed_login_count INT         NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS citext;

CREATE INDEX IF NOT EXISTS idx_crm_admins_active ON crm_admins (is_active) WHERE is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- crm_admin_sessions: refresh tokens. Access tokens are JWTs (memory-only).
-- One row per active session. Revoked sessions stay (for audit) w/ revoked_at.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_admin_sessions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id           UUID        NOT NULL REFERENCES crm_admins(id) ON DELETE CASCADE,
  refresh_token_hash TEXT        NOT NULL UNIQUE,
  user_agent         TEXT,
  ip_address         INET,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crm_admin_sessions_admin
  ON crm_admin_sessions (admin_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_admin_sessions_expires
  ON crm_admin_sessions (expires_at) WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- crm_audit_log: every write action across the entire CRM. Append-only enforced
-- at the application layer (no UPDATE/DELETE endpoints). DB-level enforcement
-- via revoke privileges in deploy scripts (not in this migration).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_audit_log (
  id           BIGSERIAL    PRIMARY KEY,
  admin_id     UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  admin_email  TEXT,
  action       TEXT         NOT NULL,
  module       TEXT         NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  before_value JSONB,
  after_value  JSONB,
  ip_address   INET,
  user_agent   TEXT,
  request_id   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_audit_admin    ON crm_audit_log (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_module   ON crm_audit_log (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_target   ON crm_audit_log (target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_created  ON crm_audit_log (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- crm_alerts: dashboard alert feed. Sources: GPS drop, SLA breach, A/B
-- auto-pause, fraud flag, webhook failure, document expiry, manual.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_alerts (
  id          BIGSERIAL    PRIMARY KEY,
  severity    TEXT         NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  source      TEXT         NOT NULL,
  message     TEXT         NOT NULL,
  link        TEXT,
  metadata    JSONB,
  read_by     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_alerts_created ON crm_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_alerts_sev     ON crm_alerts (severity, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- crm_config_snapshots: feature-flag rollback. Each save = one row. JSON blob
-- contains entire flag tree at that moment + diff vs prior snapshot.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_config_snapshots (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  admin_email  TEXT,
  reason       TEXT,
  flags_json   JSONB        NOT NULL,
  diff_json    JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_snapshots_created ON crm_config_snapshots (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- crm_login_attempts: ratelimit / lockout source of truth. Email-keyed so
-- attacker can't bypass by rotating IPs. Old rows pruned by background job.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_login_attempts (
  id          BIGSERIAL    PRIMARY KEY,
  email       CITEXT       NOT NULL,
  ip_address  INET,
  success     BOOLEAN      NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_login_attempts_email_time
  ON crm_login_attempts (email, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: bootstrap superadmin from env. Empty here — real admin row created by
-- ops via a one-off SQL script reading CRM_BOOTSTRAP_EMAIL / CRM_BOOTSTRAP_HASH
-- (see App/househelp-api/cmd/crm-api/README.md).
-- ─────────────────────────────────────────────────────────────────────────────
