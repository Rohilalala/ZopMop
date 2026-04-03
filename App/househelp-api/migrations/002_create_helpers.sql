-- 002_create_helpers.sql
-- Helpers table with PostGIS geography for spatial queries.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS helpers (
    id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    is_available BOOLEAN NOT NULL DEFAULT false,
    current_lat DECIMAL(10, 8),
    current_lng DECIMAL(11, 8),
    location GEOGRAPHY(POINT, 4326),
    rating DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
    total_jobs INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GIST index on geography column for spatial queries.
CREATE INDEX IF NOT EXISTS idx_helpers_location ON helpers USING GIST (location);

-- Index on availability for quick filtering.
CREATE INDEX IF NOT EXISTS idx_helpers_available ON helpers (is_available) WHERE is_available = true;
