-- Soft-delete column for user_addresses. Addresses are referenced by past
-- bookings via FK, so a hard DELETE fails. Switch to UPDATE-to-mark-deleted
-- and filter ListByUser by `deleted_at IS NULL`.
ALTER TABLE user_addresses
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id_active
    ON user_addresses (user_id) WHERE deleted_at IS NULL;
