-- migration 081: add reason column to crm_disputes
--
-- Customer-facing POST /api/v1/disputes sends a structured reason picker
-- value alongside free-text description. Stored separately so the CRM
-- can filter/triage by category without parsing description text.

ALTER TABLE crm_disputes
  ADD COLUMN IF NOT EXISTS reason TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_disputes_reason
  ON crm_disputes (reason, status)
  WHERE reason IS NOT NULL;
