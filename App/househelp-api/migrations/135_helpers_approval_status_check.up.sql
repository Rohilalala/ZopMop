-- CRM workers bug fix: Approve/Reject ran unconditional UPDATEs with no
-- state-machine guard. The repository now guards transitions (pending-only)
-- in SQL; this CHECK locks the approval_status domain as defense-in-depth.
--
-- NOT VALID: enforced on every new write but skips validating existing rows,
-- so the migration can't fail on any legacy approval_status value. Rollback:
--   ALTER TABLE helpers DROP CONSTRAINT helpers_approval_status_check;
ALTER TABLE helpers
  ADD CONSTRAINT helpers_approval_status_check
  CHECK (approval_status IN ('pending','approved','rejected')) NOT VALID;
