-- 100_zone_polygon.up.sql
--
-- Operational area can now be a multi-vertex polygon, not just a
-- centre + radius circle. The centre/radius columns stay for the
-- legacy circle path + back-compat; new zones drawn in CRM populate
-- `boundary`. Matching + Go-Online checks should prefer `boundary`
-- when present and fall back to ST_DWithin(centre, radius_km).
--
-- Geography type (not Geometry) so distance + within calculations
-- treat lat/lng as spherical coords without projecting. SRID 4326
-- (WGS84) matches the existing helpers.location column.
--
-- CRM polygon editor + matching-engine adoption land in a follow-up
-- phase. This migration is forward-compatible: no existing row needs
-- the column, NULL falls back to the centre+radius path.

ALTER TABLE service_zones
    ADD COLUMN IF NOT EXISTS boundary GEOGRAPHY(POLYGON, 4326);

CREATE INDEX IF NOT EXISTS idx_service_zones_boundary
    ON service_zones USING GIST (boundary)
    WHERE boundary IS NOT NULL;
