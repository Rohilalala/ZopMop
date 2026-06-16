-- CRM payouts bug fix: legacy crm_payouts mark-paid/mark-failed recorded no
-- actor at the row level (accountability lived only in the best-effort audit
-- log). Add paid_by / failed_by admin columns, mirroring the payroll-engine
-- payouts table which already stores paid_by_admin_id.
ALTER TABLE crm_payouts
  ADD COLUMN IF NOT EXISTS paid_by_admin_id   UUID REFERENCES crm_admins(id),
  ADD COLUMN IF NOT EXISTS failed_by_admin_id UUID REFERENCES crm_admins(id);
