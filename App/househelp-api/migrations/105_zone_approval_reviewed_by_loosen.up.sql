-- 105_zone_approval_reviewed_by_loosen.sql
-- Phase 11B — allow the new crm-api zone-approval handler to record the
-- reviewing admin's id. The legacy FK pointed at admin_users, but the CRM
-- v2 admin lives in crm_admins. Two parallel admin tables coexist (audit
-- doc covers this); the column is now just a free UUID with no referential
-- target. Audit recorder + crm_audit_log + audit_log carry the canonical
-- audit trail, so we don't lose lineage.
--
-- Forward-only per repo policy. No .down.sql.

ALTER TABLE zone_approval_requests
    DROP CONSTRAINT IF EXISTS zone_approval_requests_reviewed_by_fkey;
