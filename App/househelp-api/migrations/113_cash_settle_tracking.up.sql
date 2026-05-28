-- 113_cash_settle_tracking.up.sql
--
-- Phase 1 Step 3: settlement tracking for cash-resolved bookings.
--
-- Builds on migration 112, which added cash_collected_by_pro +
-- cash_collected_at to record the customer's "Yes, pay cash" decision.
-- This migration adds the two columns that close the loop: when the
-- admin physically receives the cash from the pro and clicks "Mark
-- settled" in the CRM, we stamp who did it and when. Unsettled cash =
-- the pro owes the company; settled = handed over.
--
-- The CRM "owes per pro" query (internal/crm/cash) filters on
-- cash_collected_by_pro = $1 AND cash_settled_at IS NULL. The batch-
-- settle action flips all of one pro's unsettled rows at once.
--
-- Pro payroll (internal/payroll/calc.go) is intentionally NOT joined
-- against these columns. Cash collection is a SEPARATE ledger from
-- pro pay; they never net against each other. See
-- docs/phase-1-payment-gated-flow.md.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS cash_settled_at       TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS cash_settled_by_admin UUID        NULL REFERENCES crm_admins(id);

-- Replace the broader index from migration 112 with an unsettled-only
-- partial index. The "owes" query only ever scans unsettled rows; an
-- index that also covered the settled tail would grow without bound
-- as the company processes settlements over time.
DROP INDEX IF EXISTS idx_bookings_cash_collected_by_pro;
CREATE INDEX IF NOT EXISTS idx_bookings_cash_unsettled
    ON bookings (cash_collected_by_pro, cash_collected_at)
    WHERE cash_collected_by_pro IS NOT NULL
      AND cash_settled_at IS NULL;
