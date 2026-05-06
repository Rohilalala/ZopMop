-- 076_retention_indexes.sql
-- Audit C-8 / F2D-1 chunk 10: indexes on time-anchor columns that the
-- retention worker sweeps. Without these, the first nightly sweep at
-- production scale could full-scan the table and lock it.
--
-- At current local-DB scale (10s of rows) neither index matters; both
-- are defensive against growth. Idempotent via IF NOT EXISTS.

-- booking_messages: existing index is composite (booking_id, created_at)
-- which the planner won't always pick for `WHERE created_at < cutoff`
-- alone. Add a dedicated index on created_at.
CREATE INDEX IF NOT EXISTS idx_booking_messages_created
    ON booking_messages (created_at);

-- pending_refunds: processed_at is unindexed today. Partial index
-- because only money-moved (status='processed' / 'processed_manual'
-- with non-null processed_at) rows are eligible for the time-based
-- sweep — pending / cancelled / rejected rows are hard-deleted at
-- user-erasure time per chunk 7 and never reach this index.
CREATE INDEX IF NOT EXISTS idx_pending_refunds_processed
    ON pending_refunds (processed_at)
    WHERE processed_at IS NOT NULL;
