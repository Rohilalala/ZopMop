-- 134_assigner_clash_arrived.up.sql
-- Forward-only follow-up to migration 132 (spec §5.3, plan Task 3 review).
--
-- Migration 132's idx_bookings_helper_window_gist partial predicate covered
-- only status IN ('accepted','in_progress'), but a clash must also fire on an
-- 'arrived' booking: spec §5.3 line 78 requires "no existing accepted/arrived/
-- in-progress booking", the legacy dispatch.go:checkEligibility clash used
-- IN ('accepted','in_progress','arrived'), and 'arrived' is a real reachable
-- status (MarkArrived stamps it; capacity.go committedStatusList includes it).
-- Without 'arrived' in the index predicate, an 'arrived' overlapping job is not
-- a candidate row, so the assigner's EligibleCandidates clash probe could
-- double-book a pro who has already marked arrived on an overlapping job.
--
-- 132 is already committed, so this is a forward-only drop+recreate (no editing
-- 132, no .down.sql — repo policy). The index expression is byte-for-byte the
-- same immutable form as 132 (pad added in the UTC wall-clock domain so the
-- result is IMMUTABLE and the EligibleCandidates && probe still hits the index);
-- only the partial-predicate status set gains 'arrived'. The +15 still mirrors
-- capacityTravelPadMin (internal/booking/capacity.go) — keep them in lock-step.
DROP INDEX IF EXISTS idx_bookings_helper_window_gist;

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
      AND status IN ('accepted', 'in_progress', 'arrived')
      AND scheduled_time IS NOT NULL;
