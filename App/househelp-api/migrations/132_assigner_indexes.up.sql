-- 132_assigner_indexes.up.sql
-- Unified assigner hot paths (spec §11.1). Forward-only by repo policy
-- (cmd/migrate/main.go): no .down.sql.

-- btree_gist lets a plain-equality column (helper_id, a uuid) sit alongside a
-- range column inside one GiST index, which the clash probe below needs.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Claim scan (every 60 s): only unassigned, pending rows live in this index,
-- so it stays tiny and IS the assigner's persistent priority queue — a row
-- leaves the index the instant a helper is assigned (helper_id set) or the
-- status moves off 'pending'. Range-scanned by scheduled_time to pick the rows
-- due at now() >= scheduled_time - leadMin.
CREATE INDEX IF NOT EXISTS idx_bookings_assigner_claim
    ON bookings (scheduled_time)
    WHERE status = 'pending' AND helper_id IS NULL;

-- Clash probe: interval tree over each pro's padded job windows so an overlap
-- (&&) test is one O(log n) probe instead of per-row date math. The +15 mirrors
-- capacityTravelPadMin (internal/booking/capacity.go) — that const is the single
-- source of the travel-pad minutes; keep them in lock-step. COALESCE(...,60)
-- matches the capacity gate's treatment of a missing duration as a 60-min job.
--
-- IMMUTABILITY: index expressions must be IMMUTABLE. `timestamptz + interval`
-- is only STABLE (month/day arithmetic depends on the session TZ), so the
-- obvious `scheduled_time + make_interval(...)` is rejected. We add the pad in
-- the UTC wall-clock (timestamp-without-tz) domain, where `+ interval` IS
-- immutable, then convert back: both AT TIME ZONE 'UTC' casts use a fixed
-- literal zone and the interval is minutes-only, so the result is the exact
-- same instant as the naive `+` would give — just expressed immutably. Task 3's
-- clash query MUST build its upper bound the same way for the && probe to hit.
CREATE INDEX IF NOT EXISTS idx_bookings_helper_window_gist
    ON bookings USING gist (
        helper_id,
        tstzrange(
            scheduled_time,
            (scheduled_time AT TIME ZONE 'UTC'
                 + make_interval(mins => COALESCE(total_duration_minutes, 60) + 15))
                AT TIME ZONE 'UTC'
        )
    )
    WHERE helper_id IS NOT NULL
      AND status IN ('accepted', 'in_progress')
      AND scheduled_time IS NOT NULL;
