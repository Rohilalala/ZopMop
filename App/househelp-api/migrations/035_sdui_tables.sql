-- 035_sdui_tables.sql
-- Server-driven UI tables: page configs, audit log, config schema migrations,
-- dynamic action whitelist, and home_promos.

CREATE TABLE IF NOT EXISTS sdui_page_configs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       TEXT        NOT NULL,
  version       TEXT        NOT NULL,
  env           TEXT        NOT NULL DEFAULT 'production'
                            CHECK (env IN ('production', 'staging')),
  status        TEXT        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'staged', 'active', 'archived')),
  schema_version INT        NOT NULL DEFAULT 1,
  config_json   JSONB       NOT NULL,
  name          TEXT,
  description   TEXT,
  change_notes  TEXT,
  experiment_id TEXT,
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  staged_by     TEXT,
  staged_at     TIMESTAMPTZ,
  activated_by  TEXT,
  activated_at  TIMESTAMPTZ,
  archived_by   TEXT,
  archived_at   TIMESTAMPTZ,
  UNIQUE(page_id, version, env)
);

CREATE UNIQUE INDEX IF NOT EXISTS sdui_single_active
  ON sdui_page_configs(page_id, env)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS sdui_page_configs_lookup_idx
  ON sdui_page_configs(page_id, env, status);

CREATE TABLE IF NOT EXISTS sdui_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     TEXT        NOT NULL,
  config_id   UUID        REFERENCES sdui_page_configs(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  actor       TEXT        NOT NULL,
  note        TEXT,
  snapshot    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sdui_audit_log_page_idx
  ON sdui_audit_log(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sdui_config_migrations (
  config_id    UUID        REFERENCES sdui_page_configs(id) ON DELETE CASCADE,
  from_version INT         NOT NULL,
  to_version   INT         NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (config_id, to_version)
);

CREATE TABLE IF NOT EXISTS sdui_allowed_actions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint    TEXT        NOT NULL UNIQUE,
  methods     TEXT[]      NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS home_promos (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT        NOT NULL UNIQUE,
  eyebrow       TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  body          TEXT        NOT NULL,
  cta           TEXT        NOT NULL,
  bg_color      TEXT        NOT NULL DEFAULT '#EEF2FF',
  accent_color  TEXT        NOT NULL DEFAULT '#4F46E5',
  emoji         TEXT        NOT NULL,
  screen        TEXT        NOT NULL,
  screen_params JSONB,
  display_order INT         NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS home_promos_active_idx
  ON home_promos(is_active, display_order);
