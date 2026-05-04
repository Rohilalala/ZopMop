# Geo Query Bench

pgbench harness for the radius-search query the simulation spec defines.

## Caveat

The production hot path is **Redis `GEOSEARCH`**, not Postgres. This bench
measures the Postgres fallback (`internal/matching/engine.go`
`postgresGeoFallback`). Note the in-code fallback uses `current_lat/current_lng`
haversine, which **does not** hit the GIST index. The query in
`geo_query.bench.sql` uses `ST_DWithin` on the `location` column — i.e. it
benchmarks the *better* fallback we should switch to, not the current one.

## Files

| File | Purpose |
|---|---|
| `seed_geo.sql` | Inserts 100 helpers across 7 NCR zones. Idempotent. |
| `geo_query.bench.sql` | pgbench custom script for radius query. |
| `explain_geo.sql` | One-shot `EXPLAIN ANALYZE` to verify GIST usage. |

## Run

```bash
export DATABASE_URL='postgres://...?sslmode=disable'

# 1. Seed
psql "$DATABASE_URL" -f seed_geo.sql

# 2. Verify index is used
psql "$DATABASE_URL" -f explain_geo.sql

# 3. Load test (60s, 50 concurrent clients)
pgbench -n -f geo_query.bench.sql -c 50 -j 8 -T 60 -P 5 "$DATABASE_URL"
```

## Reading results

pgbench prints:

```
latency average = X ms
latency stddev  = Y ms
tps = Z (without initial connection time)
```

For per-percentile latency, add `--progress=1 --log` and post-process
the log file:

```bash
pgbench -n -f geo_query.bench.sql -c 50 -j 8 -T 60 --log "$DATABASE_URL"
# log file: pgbench_log.<pid>
awk '{print $3}' pgbench_log.* | sort -n | \
  awk 'BEGIN{c=0} {a[c++]=$1} END{
    print "p50", a[int(c*0.50)]/1000, "ms";
    print "p95", a[int(c*0.95)]/1000, "ms";
    print "p99", a[int(c*0.99)]/1000, "ms";
  }'
```

Spec alert threshold: **p95 > 150ms**.

## Scaling caveat

100 helpers is tiny for a load test. With this dataset the GIST index
will look brilliant regardless of query plan. To stress the index,
re-seed with 100k+ rows by raising the `n` values in `seed_geo.sql`.
