CREATE TABLE IF NOT EXISTS service_variants (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id               UUID NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    code                     VARCHAR(50) NOT NULL,        -- 'default', 'small', 'standard', 'large', 'xl', 'machine_small', etc.
    label                    VARCHAR(100) NOT NULL,        -- "Standard (2BHK)" — shown to customer
    short_label              VARCHAR(50),                  -- "Standard" — for compact UI
    description              TEXT,
    price_paise              BIGINT NOT NULL,
    mrp_paise                BIGINT,                       -- crossed-out display price; nullable
    estimated_minutes        INTEGER NOT NULL,             -- time budget
    sort_order               INTEGER NOT NULL DEFAULT 0,
    is_default               BOOLEAN NOT NULL DEFAULT false, -- exactly one per service must be default
    is_active                BOOLEAN NOT NULL DEFAULT true,
    metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"room_count": 2, "utensil_units": 20}
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (service_id, code),
    CONSTRAINT variant_price_positive CHECK (price_paise > 0),
    CONSTRAINT variant_duration_positive CHECK (estimated_minutes > 0)
);

CREATE UNIQUE INDEX idx_one_default_variant_per_service
    ON service_variants (service_id) WHERE is_default = true;

CREATE INDEX idx_variants_service_active_order
    ON service_variants (service_id, is_active, sort_order) WHERE is_active = true;
