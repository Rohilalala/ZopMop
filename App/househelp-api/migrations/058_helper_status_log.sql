-- 058_helper_status_log.sql
-- Append-only history of helper online/offline transitions. Powers the CRM
-- workers timeline + the integrity check that "every pro who went OFFLINE
-- during a window has a row recorded".
--
-- Single column for status today ('online' | 'offline'). 'busy' was considered
-- but is currently derived from active bookings instead, so it stays out of
-- this table to avoid double-sourcing.

CREATE TABLE IF NOT EXISTS helper_status_log (
  id          BIGSERIAL    PRIMARY KEY,
  helper_id   UUID         NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
  status      TEXT         NOT NULL CHECK (status IN ('online','offline')),
  recorded_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_helper_status_log_helper
  ON helper_status_log (helper_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_helper_status_log_status_time
  ON helper_status_log (status, recorded_at DESC);
