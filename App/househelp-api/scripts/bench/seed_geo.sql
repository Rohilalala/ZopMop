-- seed_geo.sql
-- One-shot seed: 100 helpers across 7 Delhi NCR zones.
-- Idempotent — safe to re-run; truncates the bench-tagged rows first.
--
-- Run:  psql "$DATABASE_URL" -f seed_geo.sql
--
-- Assumes migrations applied: 001_users, 002_helpers, postgis enabled.

BEGIN;

-- Clear prior bench data (tagged via phone prefix +91-99000-xxxxx).
DELETE FROM helpers WHERE id IN (
  SELECT id FROM users WHERE phone LIKE '+919900%'
);
DELETE FROM users WHERE phone LIKE '+919900%';

-- Per-zone seeding. Coordinates jittered ±0.015deg (~1.6km) around centroid.
-- Zone counts match the simulation spec: 18+22+12+10+8+15+15 = 100.
WITH zones(name, lat, lon, n) AS (
  VALUES
    ('A_central',  28.6280, 77.2090, 18),
    ('B_south',    28.5355, 77.2167, 22),
    ('C_west',     28.6542, 77.1025, 12),
    ('D_north',    28.7041, 77.1025, 10),
    ('E_east',     28.6354, 77.3010,  8),
    ('F_noida',    28.5355, 77.3910, 15),
    ('G_gurgaon',  28.4595, 77.0266, 15)
),
expanded AS (
  SELECT z.name,
         z.lat + (random() - 0.5) * 0.03 AS lat,
         z.lon + (random() - 0.5) * 0.03 AS lon,
         gs AS i
  FROM zones z, generate_series(1, z.n) gs
),
new_users AS (
  INSERT INTO users (id, phone, role, created_at)
  SELECT gen_random_uuid(),
         '+919900' || lpad((row_number() OVER ())::text, 5, '0'),
         'pro',
         now()
  FROM expanded
  RETURNING id
),
ids AS (
  SELECT u.id, e.lat, e.lon
  FROM (SELECT id, row_number() OVER () rn FROM new_users) u
  JOIN (SELECT lat, lon, row_number() OVER () rn FROM expanded) e USING (rn)
)
INSERT INTO helpers (id, is_available, current_lat, current_lng, location, rating, total_jobs)
SELECT id,
       true,
       lat,
       lon,
       ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
       4.0 + random(),
       (random() * 200)::int
FROM ids;

ANALYZE helpers;

SELECT count(*) AS seeded_helpers FROM helpers WHERE is_available = true;

COMMIT;
