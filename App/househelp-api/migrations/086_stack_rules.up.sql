CREATE TABLE IF NOT EXISTS stack_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                VARCHAR(50) NOT NULL UNIQUE,       -- 'jpb_15', 'jpb_plus_20', 'jpb_plus_laundry_25'
    name                VARCHAR(100) NOT NULL,
    description         TEXT,
    discount_percent    NUMERIC(5,2) NOT NULL,             -- 15.00, 20.00, 25.00 — bounded
    max_discount_paise  BIGINT,                            -- optional cap
    min_subtotal_paise  BIGINT NOT NULL DEFAULT 0,
    priority            INTEGER NOT NULL DEFAULT 0,        -- higher wins when multiple rules match
    is_active           BOOLEAN NOT NULL DEFAULT true,
    starts_at           TIMESTAMPTZ,
    ends_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT stack_pct_bounds CHECK (discount_percent > 0 AND discount_percent <= 50)
);

-- A stack rule triggers when cart contains all of these services (regardless of variant).
-- If you need variant-specificity later, add a variant_id column; for now service-level is enough.
CREATE TABLE IF NOT EXISTS stack_rule_required_services (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stack_rule_id   UUID NOT NULL REFERENCES stack_rules(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES service_categories(id),
    UNIQUE (stack_rule_id, service_id)
);

CREATE INDEX idx_stack_rule_required_services_rule ON stack_rule_required_services (stack_rule_id);
