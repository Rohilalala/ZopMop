CREATE TABLE IF NOT EXISTS demand_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    hex_cell_id TEXT      NOT NULL,
    snapped_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    demand      INT       NOT NULL DEFAULT 0
);
