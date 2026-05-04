-- geo_query.bench.sql
-- pgbench custom script for the spec's ST_DWithin radius query.
--
-- Each transaction picks a random Delhi NCR centroid (one of the 7 zones),
-- jitters it ±0.02deg to simulate customer pin variance, then runs the
-- ST_DWithin + nearest-N query as written in the simulation spec.
--
-- Run:
--   pgbench -n -f geo_query.bench.sql -c 50 -j 8 -T 60 -P 5 "$DATABASE_URL"
--
--   -c 50    50 concurrent clients (≈ spec's "1000 concurrent" mapped to
--             realistic pool size; raise to -c 100 if pool allows)
--   -j 8     8 worker threads
--   -T 60    run 60 seconds
--   -P 5     progress every 5s
--
-- pgbench reports latency p50/p95/p99 and TPS.
-- Spec alert threshold: p95 > 150ms.
--
-- After the run, capture EXPLAIN to confirm GIST index usage:
--   psql "$DATABASE_URL" -f explain_geo.sql

\set zone_idx random(1, 7)
\set jitter_lat random(-200, 200)
\set jitter_lon random(-200, 200)

-- Pick centroid for the chosen zone (CASE expanded inline so pgbench
-- variable substitution stays simple). Jitter divides 10000 to get ±0.02deg.
SELECT pro_id,
       ST_Distance(location,
                   ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography) AS dist
FROM (
  SELECT
    (CASE :zone_idx
       WHEN 1 THEN 28.6280 WHEN 2 THEN 28.5355 WHEN 3 THEN 28.6542
       WHEN 4 THEN 28.7041 WHEN 5 THEN 28.6354 WHEN 6 THEN 28.5355
       WHEN 7 THEN 28.4595
     END) + :jitter_lat / 10000.0 AS lat,
    (CASE :zone_idx
       WHEN 1 THEN 77.2090 WHEN 2 THEN 77.2167 WHEN 3 THEN 77.1025
       WHEN 4 THEN 77.1025 WHEN 5 THEN 77.3010 WHEN 6 THEN 77.3910
       WHEN 7 THEN 77.0266
     END) + :jitter_lon / 10000.0 AS lng
) c,
LATERAL (
  SELECT h.id AS pro_id, h.location
  FROM helpers h
  WHERE h.is_available = true
    AND ST_DWithin(
          h.location,
          ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
          5000
        )
  ORDER BY h.location <-> ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography
  LIMIT 10
) p;
