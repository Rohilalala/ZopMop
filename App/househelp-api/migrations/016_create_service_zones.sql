-- 016_create_service_zones.sql
-- Defines operational zones. Each row is a lat/lon point with a radius.
-- A location is serviceable if it falls within ANY active zone's radius.

CREATE TABLE IF NOT EXISTS service_zones (
    id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100)  NOT NULL,
    city       VARCHAR(100)  NOT NULL,
    lat        DECIMAL(9,6)  NOT NULL,
    lon        DECIMAL(9,6)  NOT NULL,
    radius_km  DECIMAL(5,2)  NOT NULL DEFAULT 2.5,
    is_active  BOOLEAN       NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_zones_active ON service_zones (is_active) WHERE is_active = true;

-- Seed: Gurugram covered by a single 15km zone (covers the whole city).
-- Add more fine-grained rows (2.5km each) as operations expand.
INSERT INTO service_zones (name, city, lat, lon, radius_km) VALUES
    ('Gurugram', 'Gurugram', 28.4595, 77.0266, 15.0)
ON CONFLICT DO NOTHING;
