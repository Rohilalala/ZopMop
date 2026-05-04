-- 058_seed_ncr_zones.sql
-- Seed the 7 Delhi NCR operational zones used by the matching/serviceability
-- check (CheckServiceability in internal/zones/repository.go). Each zone is a
-- centroid + 5km radius — fits the existing service_zones schema (016).
-- Idempotent: ON CONFLICT keys on (city, name) which we add as a unique
-- constraint here so re-runs don't duplicate rows.

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_zones_city_name
    ON service_zones (city, name);

INSERT INTO service_zones (name, city, lat, lon, radius_km) VALUES
    ('Central Delhi', 'Delhi',   28.6280, 77.2090, 5.0),
    ('South Delhi',   'Delhi',   28.5355, 77.2167, 5.0),
    ('West Delhi',    'Delhi',   28.6542, 77.1025, 5.0),
    ('North Delhi',   'Delhi',   28.7041, 77.1025, 5.0),
    ('East Delhi',    'Delhi',   28.6354, 77.3010, 5.0),
    ('Noida',         'Noida',   28.5355, 77.3910, 8.0),
    ('Gurgaon',       'Gurgaon', 28.4595, 77.0266, 8.0)
ON CONFLICT (city, name) DO NOTHING;
