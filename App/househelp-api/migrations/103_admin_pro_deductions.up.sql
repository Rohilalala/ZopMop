-- 103_admin_pro_deductions.sql
-- Phase 11B — manual fortnight deductions applied by CRM admins.
-- Each row records an admin-initiated reduction in a pro's payout for
-- a given fortnight. Read alongside automatic deductions (absences,
-- cancellations) when computing fortnight payouts.

CREATE TABLE IF NOT EXISTS admin_pro_deductions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pro_id          UUID NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    admin_id        UUID NOT NULL REFERENCES crm_admins(id),
    amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
    reason          TEXT NOT NULL,
    -- Snapshot the fortnight the pro was in when the admin clicked
    -- Apply. Allows reversal tooling later to find rows by fortnight.
    fortnight_start DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reversed_at     TIMESTAMPTZ,
    reversed_by     UUID REFERENCES crm_admins(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_pro_deductions_pro
    ON admin_pro_deductions (pro_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_pro_deductions_pro_active_fortnight
    ON admin_pro_deductions (pro_id, fortnight_start)
    WHERE reversed_at IS NULL;
