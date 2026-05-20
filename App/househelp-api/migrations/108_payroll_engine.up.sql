-- 108_payroll_engine.up.sql
--
-- Payroll engine — first version. Hourly pay model:
--   ₹80/hr for online time + ₹80/hr bonus for working time
--   (working ⊆ online). Cycles: 1–15 and 16–end-of-month, paid on
--   cycle close dates at 01:00 IST. Targets: 80 online hours and
--   ≥85% acceptance rate per fortnight, prorated by days_available.
--   Warnings only — never auto-deactivates.
--
-- This migration is schema-only. The cron, calculation, admin
-- payouts view, and target tracking ship in follow-up PRs.
--
-- Forward-only per backend CLAUDE.md (no .down.sql).
--
-- ─── 1. helpers.effective_start_date ────────────────────────────────
-- "pros" in the design doc → helpers in this repo (PK = users(id),
-- role='pro'). effective_start_date anchors proration for the
-- fortnight target, scopes absence checks, and bounds payout
-- calculations for a pro joined mid-cycle.
--
-- Onboarding rule (enforced in app code, not the DB default):
--   * signup before today's 03:00 IST cutoff → effective = today
--   * else                                   → effective = tomorrow
-- The column default falls back to current_date so unknown writers
-- don't crash; the helper-creation path overrides explicitly.
ALTER TABLE helpers
    ADD COLUMN IF NOT EXISTS effective_start_date DATE;

-- Backfill existing rows from helpers.created_at, cast to the IST
-- calendar date. created_at is TIMESTAMPTZ stored as UTC; the
-- AT TIME ZONE rotates the instant into Asia/Kolkata before
-- truncating to a date.
UPDATE helpers
   SET effective_start_date = (created_at AT TIME ZONE 'Asia/Kolkata')::date
 WHERE effective_start_date IS NULL;

ALTER TABLE helpers
    ALTER COLUMN effective_start_date SET NOT NULL,
    ALTER COLUMN effective_start_date SET DEFAULT current_date;

-- ─── 2. payouts ─────────────────────────────────────────────────────
-- One row per pro per cycle. Cycle bounds are anchored to the
-- calendar month: (1st .. 15th) and (16th .. last-of-month). The
-- cron writes status='pending_manual_payout'; an admin marks it
-- 'paid' with a transaction_id after wiring funds.
--
-- UNIQUE (pro_id, cycle_start) guarantees idempotency — the cron
-- can re-run safely. Cycle bounds are stored explicitly (not
-- derivable from cycle_start alone in February) so the cron can
-- back-compute against the snapshot.
CREATE TABLE IF NOT EXISTS payouts (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pro_id             UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    cycle_start        DATE        NOT NULL,
    cycle_end          DATE        NOT NULL,

    -- Worked-time snapshot. Stored in minutes for exact arithmetic;
    -- pay fields are computed from these and the ₹80/hr rate (held
    -- in code, not the DB, so a rate change doesn't require a
    -- migration).
    online_minutes     INT         NOT NULL DEFAULT 0,
    working_minutes    INT         NOT NULL DEFAULT 0,

    -- Pay breakdown. paise = ₹/100. BIGINT to be safe well past
    -- the int-32 ceiling for very long cycles.
    base_pay_paise     BIGINT      NOT NULL DEFAULT 0,
    work_bonus_paise   BIGINT      NOT NULL DEFAULT 0,
    gross_pay_paise    BIGINT      NOT NULL DEFAULT 0,
    deductions_paise   BIGINT      NOT NULL DEFAULT 0,
    net_pay_paise      BIGINT      NOT NULL DEFAULT 0,

    status             VARCHAR(32) NOT NULL DEFAULT 'pending_manual_payout'
        CHECK (status IN ('pending_manual_payout','paid','cancelled')),
    transaction_id     TEXT,
    paid_at            TIMESTAMPTZ,
    paid_by            UUID        REFERENCES admin_users(id),
    notes              TEXT,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (pro_id, cycle_start),
    CHECK (cycle_end >= cycle_start)
);

-- Admin CRM payouts list — "show me everything still pending,
-- oldest cycle first".
CREATE INDEX IF NOT EXISTS idx_payouts_status_cycle
    ON payouts (status, cycle_start)
    WHERE status = 'pending_manual_payout';

-- Per-pro history view.
CREATE INDEX IF NOT EXISTS idx_payouts_pro_cycle
    ON payouts (pro_id, cycle_start DESC);

-- ─── 3. dispatched_jobs ─────────────────────────────────────────────
-- Acceptance-rate ledger. The dispatcher writes one row per
-- (pro, booking) offer; the response column records the outcome.
--
-- pro_was_online_at_offer / pro_on_another_job_at_offer are
-- captured at offer time so the rollup query can apply the
-- "denominator = offered while online AND not on another job"
-- rule without re-deriving state retrospectively.
--
-- Accept-then-cancel is a separate reliability metric and not
-- tracked here — booking_cancellations covers that.
CREATE TABLE IF NOT EXISTS dispatched_jobs (
    id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pro_id                        UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    booking_id                    UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    offered_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    response                      VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (response IN ('pending','accepted','declined','timed_out')),
    responded_at                  TIMESTAMPTZ,
    pro_was_online_at_offer       BOOLEAN     NOT NULL DEFAULT false,
    pro_on_another_job_at_offer   BOOLEAN     NOT NULL DEFAULT false,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A given pro can only be offered a given booking once. Re-tries
    -- are no-ops; the existing row's response is updated in place.
    UNIQUE (pro_id, booking_id)
);

-- Fortnight rollup query: "all eligible offers for this pro in
-- [cycle_start, cycle_end]".
CREATE INDEX IF NOT EXISTS idx_dispatched_jobs_pro_time
    ON dispatched_jobs (pro_id, offered_at DESC);

-- Operational "who hasn't responded yet" query.
CREATE INDEX IF NOT EXISTS idx_dispatched_jobs_pending
    ON dispatched_jobs (offered_at)
    WHERE response = 'pending';
