-- CRM workers bug fix: worker reject required a reason but discarded it (the
-- reason survived only in the audit log). Persist it on the helper so the
-- rejection rationale is visible on the record, alongside suspend_reason.
ALTER TABLE helpers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
