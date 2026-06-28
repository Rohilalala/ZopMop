-- Remove the v1 service "emoji" icon field. Services now render through the
-- PNG icon system (frontend serviceIcon.ts); the emoji column and every Go/TS
-- path that read or wrote it have been removed.
--
-- Earlier seed migrations (015/017/025/112) still INSERT an emoji value — that
-- is fine: the column exists while they run, and this DROP executes last in the
-- forward chain. No view/constraint depends on the column (verified via
-- pg_depend), so the drop is clean.
ALTER TABLE service_categories DROP COLUMN IF EXISTS emoji;
