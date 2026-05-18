-- 099_zone_shift_radius.up.sql
--
-- Phase 7 follow-up: separate the Go-Online verification radius
-- from the service-area radius.
--
-- service_zones.radius_km (already existed) = customer-facing
--   service area. e.g. "ZopMop serves anywhere within 15 km of
--   this point in Gurugram".
--
-- service_zones.shift_radius_km (new) = stricter Go-Online check.
--   The pro's GPS must be within this distance of the zone centre
--   when they tap Go Online. Falls back to 1.0 km when null so a
--   zone left unconfigured still gets the spec default.

ALTER TABLE service_zones
    ADD COLUMN IF NOT EXISTS shift_radius_km DECIMAL(5,2) NOT NULL DEFAULT 1.0;

-- Bump existing zones to a reasonable urban default. Ops can tune
-- per-zone later via the admin UI.
UPDATE service_zones SET shift_radius_km = 3.0 WHERE shift_radius_km = 1.0 AND radius_km >= 10;
