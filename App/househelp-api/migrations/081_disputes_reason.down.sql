DROP INDEX IF EXISTS idx_crm_disputes_reason;
ALTER TABLE crm_disputes DROP COLUMN IF EXISTS reason;
