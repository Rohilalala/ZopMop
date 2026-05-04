-- 047_helpers_last_location_at.sql
-- Add a heartbeat timestamp to helpers so the CRM live-map can distinguish
-- "currently pinging location" from "is_available was set TRUE hours ago and
-- the app got killed". Stamped every UpdateLocation; live-pins query filters
-- to rows whose last ping is within a recency window.
ALTER TABLE helpers
  ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_helpers_last_location_at
  ON helpers (last_location_at)
  WHERE last_location_at IS NOT NULL;
