-- 109_payroll_admin_audit.up.sql
--
-- Admin-side payroll surface: the payout_audit_log ledger that
-- captures every status change on a payouts row, plus the
-- additional columns the CRM handler writes (failure_reason +
-- a CRM-admin-scoped paid_by FK).
--
-- Forward-only per backend CLAUDE.md (no .down.sql).

-- ─── 1. payouts: new columns + expanded status set ──────────────────
-- payouts.paid_by (from migration 108) FK's admin_users. The CRM
-- runs on its own admin table (crm_admins), so a CRM admin marking
-- a row paid must record its identity in a column that FKs the
-- right table. paid_by stays around for backwards-compat; the CRM
-- handler writes paid_by_admin_id.
ALTER TABLE payouts
    ADD COLUMN IF NOT EXISTS paid_by_admin_id UUID REFERENCES crm_admins(id),
    ADD COLUMN IF NOT EXISTS failure_reason   TEXT;

-- Expand status: add 'failed' (reversible by recompute) and
-- 'skipped' (cron decided not to write). Drop + re-add the CHECK
-- so existing data passes cleanly — no row in production can hold
-- a new value yet (payouts table only landed in 108).
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
ALTER TABLE payouts
    ADD CONSTRAINT payouts_status_check
    CHECK (status IN (
        'pending_manual_payout',
        'paid',
        'cancelled',
        'failed',
        'skipped'
    ));

-- ─── 2. payout_audit_log ────────────────────────────────────────────
-- One row per status-changing action on a payouts row. before_state
-- and after_state are full JSON snapshots so a row's complete
-- history can be reconstructed even if columns change shape later.
--
-- admin_id FKs crm_admins so the dashboard can join through to
-- admin email + display name without an extra lookup table.
CREATE TABLE IF NOT EXISTS payout_audit_log (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_id     UUID        NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
    admin_id      UUID        REFERENCES crm_admins(id) ON DELETE SET NULL,
    action        TEXT        NOT NULL
        CHECK (action IN ('computed','mark_paid','mark_failed','recomputed','notes_updated')),
    before_state  JSONB,
    after_state   JSONB,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drawer query: "show me the timeline for this payout, newest
-- first".
CREATE INDEX IF NOT EXISTS idx_payout_audit_log_payout_time
    ON payout_audit_log (payout_id, created_at DESC);
