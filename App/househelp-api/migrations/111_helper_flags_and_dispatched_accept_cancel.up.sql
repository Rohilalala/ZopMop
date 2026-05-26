-- 110_helper_flags_and_dispatched_accept_cancel.up.sql
--
-- Performance flags written by the payroll cron at cycle close, plus
-- an accept-then-cancel column on dispatched_jobs for the reliability
-- metric.
--
-- Forward-only per backend CLAUDE.md (no .down.sql).

-- ─── 1. dispatched_jobs.accept_then_cancel ──────────────────────────
-- Spec carves accept-then-cancel out of the acceptance-rate metric and
-- tracks it as a separate reliability signal. The column is updated by
-- the booking-cancel handler when the pro who accepted later cancels.
ALTER TABLE dispatched_jobs
    ADD COLUMN IF NOT EXISTS accept_then_cancel BOOLEAN NOT NULL DEFAULT false;

-- Lookup for the metric: "how often did this pro accept-then-cancel".
CREATE INDEX IF NOT EXISTS idx_dispatched_jobs_pro_accept_cancel
    ON dispatched_jobs (pro_id)
    WHERE accept_then_cancel = true;

-- ─── 2. helper_flags ────────────────────────────────────────────────
-- One row per (helper, cycle, flag_type). The payroll cron writes
-- flags after computing the payout; admin reviews and dismisses or
-- escalates them. NEVER drives auto-deactivation — flags are
-- review-only per the handoff spec.
CREATE TABLE IF NOT EXISTS helper_flags (
    id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    helper_id             UUID         NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    cycle_start           DATE         NOT NULL,
    cycle_end             DATE         NOT NULL,
    flag_type             TEXT         NOT NULL
        CHECK (flag_type IN ('hours_target_missed', 'acceptance_below_threshold')),

    -- Numeric snapshots — both stored so the CRM card can render the
    -- exact "logged 41h / target 63h" or "62% / required 85%" string
    -- without recomputing from raw sessions.
    actual_value          NUMERIC(10, 4) NOT NULL,
    expected_value        NUMERIC(10, 4) NOT NULL,

    -- Structured context for the drawer detail view (dispatched count,
    -- accepted count, days_available, etc.). JSONB so we can add
    -- fields later without a schema migration.
    details               JSONB,

    status                TEXT         NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'reviewed', 'dismissed', 'escalated')),

    reviewed_by_admin_id  UUID         REFERENCES crm_admins(id) ON DELETE SET NULL,
    reviewed_at           TIMESTAMPTZ,
    review_notes          TEXT,

    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- Idempotency: cron re-run for the same cycle never writes a
    -- duplicate flag for the same helper+type.
    UNIQUE (helper_id, cycle_start, flag_type)
);

CREATE INDEX IF NOT EXISTS idx_helper_flags_open
    ON helper_flags (status, created_at DESC)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_helper_flags_helper_cycle
    ON helper_flags (helper_id, cycle_start DESC);

-- ─── 3. helpers.deactivated_at ──────────────────────────────────────
-- Anchors target proration when a helper is deactivated mid-cycle.
-- The existing is_suspended / approval_status fields capture status
-- but not the moment the lifecycle event happened, which is what the
-- proration formula needs (max(effective_start_date, cycle_start) ..
-- min(deactivated_at, cycle_end)).
ALTER TABLE helpers
    ADD COLUMN IF NOT EXISTS deactivated_at DATE;
