-- 147_shift_sessions_online_at_index
-- The CRM shift-sessions admin view orders by online_at DESC; add a matching
-- index so the list query doesn't full-scan + sort the whole table.
CREATE INDEX IF NOT EXISTS idx_shift_sessions_online_at
    ON shift_sessions (online_at DESC);
