-- explain_geo.sql
-- Confirm the GIST index on helpers.location is being used.
-- Run after seed_geo.sql + ANALYZE. Look for "Index Scan using idx_helpers_location"
-- (or Bitmap Index Scan). If you see "Seq Scan", the index is unused — investigate.

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT h.id AS pro_id,
       ST_Distance(h.location,
                   ST_SetSRID(ST_MakePoint(77.2090, 28.6280), 4326)::geography) AS dist
FROM helpers h
WHERE h.is_available = true
  AND ST_DWithin(
        h.location,
        ST_SetSRID(ST_MakePoint(77.2090, 28.6280), 4326)::geography,
        5000
      )
ORDER BY h.location <-> ST_SetSRID(ST_MakePoint(77.2090, 28.6280), 4326)::geography
LIMIT 10;
