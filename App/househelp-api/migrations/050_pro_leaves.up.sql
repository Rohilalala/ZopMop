-- 050_pro_leaves.sql
-- Pro leave management. Adds monthly-resetting balance to helpers and a
-- pro_leaves table tracking declared/admin-allocated days.
--
-- Balance semantics:
--   leave_balance              — remaining days the pro can spend this month
--   leave_balance_reset_at     — when the balance was last reset (or
--                                 set by admin); used by the lazy reset path
--                                 to detect when a fresh month has begun.
--   monthly_leave_quota        — monthly entitlement; default 2 (per spec).
--                                 Admin can raise this for individual pros.

ALTER TABLE helpers
    ADD COLUMN IF NOT EXISTS leave_balance          INTEGER     NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS monthly_leave_quota    INTEGER     NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS leave_balance_reset_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now());

CREATE TABLE IF NOT EXISTS pro_leaves (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pro_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date        DATE        NOT NULL,
    declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status      VARCHAR(20) NOT NULL DEFAULT 'approved'
                    CHECK (status IN ('approved', 'cancelled')),
    -- Source of the leave row: 'pro' = self-declared, 'admin' = manually
    -- allocated by an admin (e.g. medical / approved leave outside quota).
    source      VARCHAR(20) NOT NULL DEFAULT 'pro'
                    CHECK (source IN ('pro', 'admin')),
    note        TEXT,
    UNIQUE (pro_id, date)
);

CREATE INDEX IF NOT EXISTS idx_pro_leaves_pro_date_status
    ON pro_leaves (pro_id, date) WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_pro_leaves_date_status
    ON pro_leaves (date) WHERE status = 'approved';
