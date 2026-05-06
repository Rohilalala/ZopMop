-- 004_create_service_categories.sql
-- Service categories that define available service types.

CREATE TABLE IF NOT EXISTS service_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon_url TEXT,
    base_price_cents INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Composite index for active categories ordered by display_order.
CREATE INDEX IF NOT EXISTS idx_service_categories_active_order
    ON service_categories (is_active, display_order)
    WHERE is_active = true;
