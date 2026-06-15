-- 136_slot_capacity_gating.up.sql (renumbered from 131 to clear the fix/pro-crm-audit-sweep collision)
-- Slot capacity gating (pilot: single society, Orchid Island Gurugram).
--
-- Capacity is LIVE-derived at read/booking time — there is no counter column.
-- available(slot) = approved roster helpers in locality
--                   − helpers on approved leave that date
--                   − committed bookings whose [scheduled_time, scheduled_time
--                     + total_duration_minutes + 15min travel pad) window overlaps the slot window.
-- A slot is bookable iff available > 0. Cancellations free capacity for free
-- because a cancelled booking drops out of the committed set.
--
-- Forward-only by repo policy (cmd/migrate/main.go): no .down.sql.

-- Pilot locality. resolveGateLocality() defaults every unresolved address to
-- this row, so it must exist before the gate goes live. Seed 055 did not
-- include it. ON CONFLICT keeps this idempotent and safe to re-run.
INSERT INTO localities (name, city, active)
VALUES ('Orchid Island Gurugram', 'Gurugram', true)
ON CONFLICT (name, city) DO NOTHING;

-- Supports the committed-bookings overlap count: filter by locality + the
-- in-flight status set, range-scan scheduled_time. Partial so it stays small
-- (terminal bookings — completed/cancelled — are excluded, matching the
-- committed set used by committedCountForSlot).
CREATE INDEX IF NOT EXISTS idx_bookings_locality_sched
    ON bookings (locality, scheduled_time)
    WHERE status IN ('pending', 'searching', 'accepted', 'arrived', 'in_progress')
      AND scheduled_time IS NOT NULL;
