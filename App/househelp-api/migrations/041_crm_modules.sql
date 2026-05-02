-- 041_crm_modules.sql
-- New tables and extensions for the remaining CRM modules. Kept in one
-- migration to keep the boundary clear: everything below is "added by CRM v2"
-- and can be dropped together if that effort is ever rolled back.

-- ── Promotions extensions ───────────────────────────────────────────────────
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS name        TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS audience    TEXT  NOT NULL DEFAULT 'all'
                                       CHECK (audience IN ('all','new_users','vip','specific')),
  ADD COLUMN IF NOT EXISTS audience_user_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS categories  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS stackable   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS max_per_user INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS starts_at   TIMESTAMPTZ;

-- ── Banners extensions ──────────────────────────────────────────────────────
ALTER TABLE banners
  ADD COLUMN IF NOT EXISTS audience      TEXT NOT NULL DEFAULT 'all'
                                          CHECK (audience IN ('all','new_users','vip','zone')),
  ADD COLUMN IF NOT EXISTS audience_zone UUID REFERENCES service_zones(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cta_label     TEXT,
  ADD COLUMN IF NOT EXISTS cta_kind      TEXT
                                          CHECK (cta_kind IN ('category','promo','external','deeplink'));

-- ── A/B Experiments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_experiments (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT         NOT NULL,
  hypothesis      TEXT,
  kind            TEXT         NOT NULL CHECK (kind IN ('flag','banner','promo','ui')),
  target_key      TEXT,                              -- flag key / banner id / promo code
  variants        JSONB        NOT NULL,             -- [{ id, name, value, traffic_pct }]
  metric          TEXT         NOT NULL,             -- e.g. "booking_conversion"
  audience        TEXT         NOT NULL DEFAULT 'all',
  status          TEXT         NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','running','paused','completed','rolled_out')),
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  winner_variant  TEXT,
  created_by      UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_experiments_status
  ON crm_experiments (status, created_at DESC);

-- ── Surge & Dynamic Pricing ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_surge_rules (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id     UUID         NOT NULL REFERENCES service_zones(id) ON DELETE CASCADE,
  multiplier  NUMERIC(4,2) NOT NULL CHECK (multiplier > 0 AND multiplier <= 5),
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  conditions  JSONB,                          -- { workers_below, demand_above, etc }
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  reason      TEXT,
  created_by  UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_surge_rules_zone ON crm_surge_rules (zone_id, is_active);

-- ── Worker Payouts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_payouts (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,
  amount_cents BIGINT       NOT NULL CHECK (amount_cents >= 0),
  status       TEXT         NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','processing','paid','failed')),
  paid_at      TIMESTAMPTZ,
  external_ref TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_payouts_worker ON crm_payouts (worker_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_crm_payouts_status ON crm_payouts (status, period_end DESC);

-- ── Disputes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_disputes (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID         REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id   UUID         REFERENCES users(id) ON DELETE SET NULL,
  worker_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  source        TEXT         NOT NULL DEFAULT 'customer'
                             CHECK (source IN ('customer','worker','system','admin')),
  description   TEXT         NOT NULL,
  severity      TEXT         NOT NULL DEFAULT 'medium'
                             CHECK (severity IN ('low','medium','high','critical')),
  level         TEXT         NOT NULL DEFAULT 'L1'
                             CHECK (level IN ('L1','L2','L3')),
  status        TEXT         NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open','in_progress','resolved','escalated','closed')),
  resolution    TEXT,
  assigned_to   UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  sla_due_at    TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_disputes_status ON crm_disputes (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_disputes_assigned ON crm_disputes (assigned_to, status);

-- ── Fraud Flags + Blacklist ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_fraud_flags (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         REFERENCES users(id) ON DELETE CASCADE,
  pattern     TEXT         NOT NULL,        -- "device_dup","promo_abuse","impossible_gps","high_refund_rate"
  details     JSONB,
  status      TEXT         NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','reviewed_false','actioned')),
  reviewed_by UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_fraud_flags_user   ON crm_fraud_flags (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_fraud_flags_status ON crm_fraud_flags (status, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_blacklist (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT         NOT NULL CHECK (kind IN ('phone','email','device_id','ip')),
  value       TEXT         NOT NULL,
  reason      TEXT         NOT NULL,
  created_by  UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS idx_crm_blacklist_value ON crm_blacklist (kind, value);

-- ── Webhooks ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_webhooks (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  url          TEXT         NOT NULL,
  events       TEXT[]       NOT NULL DEFAULT '{}',
  secret       TEXT,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by   UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crm_webhook_deliveries (
  id          BIGSERIAL    PRIMARY KEY,
  webhook_id  UUID         NOT NULL REFERENCES crm_webhooks(id) ON DELETE CASCADE,
  event       TEXT         NOT NULL,
  payload     JSONB        NOT NULL,
  status_code INT,
  response    TEXT,
  attempt     INT          NOT NULL DEFAULT 1,
  succeeded   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_webhook_deliveries
  ON crm_webhook_deliveries (webhook_id, created_at DESC);

-- ── Response Templates ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_response_templates (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  category   TEXT         NOT NULL,        -- "refund","complaint","worker_issue","general"
  name       TEXT         NOT NULL,
  body       TEXT         NOT NULL,
  created_by UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_templates_category ON crm_response_templates (category);

-- ── Support Tickets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_support_tickets (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  subject     TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  status      TEXT         NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','in_progress','resolved','closed')),
  priority    TEXT         NOT NULL DEFAULT 'normal'
                           CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_tickets_status ON crm_support_tickets (status, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_support_ticket_messages (
  id          BIGSERIAL    PRIMARY KEY,
  ticket_id   UUID         NOT NULL REFERENCES crm_support_tickets(id) ON DELETE CASCADE,
  admin_id    UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  admin_email TEXT,
  body        TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── App Versions + Changelog ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_app_versions (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  platform        TEXT         NOT NULL CHECK (platform IN ('ios','android','any')),
  min_version     TEXT         NOT NULL,
  force_update    BOOLEAN      NOT NULL DEFAULT FALSE,
  force_message   TEXT,
  created_by      UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_changelog (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  version     TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  is_published BOOLEAN     NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  created_by  UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── Incidents ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_incidents (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  severity      TEXT         NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  source        TEXT         NOT NULL,
  description   TEXT         NOT NULL,
  involved_user_id   UUID    REFERENCES users(id) ON DELETE SET NULL,
  involved_worker_id UUID    REFERENCES users(id) ON DELETE SET NULL,
  actions_taken TEXT,
  status        TEXT         NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open','investigating','resolved','closed')),
  created_by    UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_incidents_severity ON crm_incidents (severity, created_at DESC);

-- ── Push / In-App / Lost-User / Loyalty / Waitlist ──────────────────────────
CREATE TABLE IF NOT EXISTS crm_push_messages (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT         NOT NULL,
  body          TEXT         NOT NULL,
  image_url     TEXT,
  deep_link     TEXT,
  target_kind   TEXT         NOT NULL CHECK (target_kind IN ('users','pros','both','specific')),
  target_filter JSONB,
  estimated_reach INT        NOT NULL DEFAULT 0,
  scheduled_at  TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  status        TEXT         NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','scheduled','sent','failed')),
  created_by    UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_push_status ON crm_push_messages (status, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_inapp_messages (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT         NOT NULL,
  body         TEXT         NOT NULL,
  is_read      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_inapp_user ON crm_inapp_messages (user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_lost_user_campaigns (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT         NOT NULL,
  inactive_days INT          NOT NULL DEFAULT 30,
  trigger_kind  TEXT         NOT NULL DEFAULT 'push'
                             CHECK (trigger_kind IN ('push','promo','both')),
  promo_code    TEXT,
  push_title    TEXT,
  push_body     TEXT,
  is_active     BOOLEAN      NOT NULL DEFAULT FALSE,
  triggered_count INT        NOT NULL DEFAULT 0,
  conversion_count INT       NOT NULL DEFAULT 0,
  created_by    UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_loyalty_config (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  is_enabled            BOOLEAN      NOT NULL DEFAULT FALSE,
  points_per_100_inr    INT          NOT NULL DEFAULT 1,
  points_per_redeem_inr INT          NOT NULL DEFAULT 100,
  bonus_rules           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  updated_by            UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_loyalty_balances (
  user_id    UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  points     INT          NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_waitlists (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  city        TEXT         NOT NULL,
  category    TEXT,
  description TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_waitlist_entries (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_id UUID         NOT NULL REFERENCES crm_waitlists(id) ON DELETE CASCADE,
  email       CITEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_waitlist_entries_list ON crm_waitlist_entries (waitlist_id, created_at DESC);
