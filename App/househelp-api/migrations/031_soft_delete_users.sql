-- 031_soft_delete_users.sql
-- Adds soft-delete columns to users so account-deletion requests (App Store
-- Guideline 5.1.1(v)) can be honoured while preserving referential integrity
-- on bookings, roomies ledgers, and audit logs. A nightly job (outside this
-- migration) hard-purges rows where deleted_at < now() - interval '30 days'.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(200);

-- Index to let auth lookups exclude deleted rows cheaply.
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at)
    WHERE deleted_at IS NOT NULL;
