-- ─────────────────────────────────────────────────────────────────────────────
-- 018: Matching engine schema additions
-- Adds hex-cell indexing, demand snapshots, and per-booking match metadata.
-- ─────────────────────────────────────────────────────────────────────────────

-- Hex cell ID on bookings (used by batch processor to group nearby requests)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hex_cell_id    VARCHAR(30);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS match_attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS matched_at     TIMESTAMPTZ;

-- Partial index: only pending bookings have cells worth scanning
CREATE INDEX IF NOT EXISTS idx_bookings_cell_pending
    ON bookings (hex_cell_id, created_at)
    WHERE status = 'pending';

-- Hex cell ID on helpers (updated each time the helper's location is stored)
ALTER TABLE helpers ADD COLUMN IF NOT EXISTS hex_cell_id VARCHAR(30);

CREATE INDEX IF NOT EXISTS idx_helpers_cell_available
    ON helpers (hex_cell_id)
    WHERE is_available = true;

-- ── Demand snapshots ──────────────────────────────────────────────────────────
-- Persistent daily heatmap of booking requests per cell.
-- Redis is the live store; this table captures end-of-day snapshots for analytics.
CREATE TABLE IF NOT EXISTS demand_snapshots (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    snap_date   DATE        NOT NULL,
    hex_cell_id VARCHAR(30) NOT NULL,
    req_count   INTEGER     NOT NULL DEFAULT 0,
    UNIQUE (snap_date, hex_cell_id)
);

CREATE INDEX IF NOT EXISTS idx_demand_snaps_date
    ON demand_snapshots (snap_date DESC);

-- ── New matching config keys ──────────────────────────────────────────────────
INSERT INTO app_config (key, value, value_type, description)
VALUES
    ('matching.batch_interval_seconds', '5',    'int',   'How often the batch matcher runs (seconds)'),
    ('matching.hex_rings',              '2',    'int',   'Cell rings to search — each ring ≈ 500 m (1=500m,2=1km,3=1.5km)'),
    ('matching.min_score_threshold',    '0.25', 'float', 'Minimum composite score to include a helper in the notify list')
ON CONFLICT (key) DO NOTHING;
