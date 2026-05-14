CREATE TABLE IF NOT EXISTS bundles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(50) NOT NULL UNIQUE,           -- 'daily_essentials', 'weekend_reset'
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    bundle_price_paise BIGINT NOT NULL,                    -- the actual charged price
    mrp_paise       BIGINT,                                -- sum of constituent variants' prices, for display
    total_minutes   INTEGER NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    badge_text      VARCHAR(30),                           -- 'BEST VALUE', 'POPULAR'
    icon_url        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bundle_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bundle_id       UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES service_variants(id),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (bundle_id, variant_id)
);

CREATE INDEX idx_bundle_items_bundle ON bundle_items (bundle_id);
