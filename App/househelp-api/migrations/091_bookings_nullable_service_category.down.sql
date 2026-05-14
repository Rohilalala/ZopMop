ALTER TABLE bookings DROP COLUMN IF EXISTS summary_label;
-- WARNING: SET NOT NULL will fail if any rows have NULL in service_category_id.
-- Since Phase 1 made no Go changes, no NULLs should have been inserted during
-- Phase 1. If running this after Phase 4, check for NULLs before proceeding.
ALTER TABLE bookings ALTER COLUMN service_category_id SET NOT NULL;
