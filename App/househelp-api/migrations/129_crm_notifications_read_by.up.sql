-- 126_crm_notifications_read_by.up.sql
-- The CRM notification centre was per-admin in name only: a single global
-- read_at column meant one admin's "mark all read" cleared the unread feed
-- (including urgent rows) for EVERY admin. Mirror the crm_alerts model with a
-- per-admin read_by JSONB array so read-state is scoped to the calling admin.
--
-- Backfill: rows previously stamped read_at are seeded with a sentinel so they
-- don't suddenly resurface as unread for everyone after deploy. They simply
-- won't be attributed to a specific admin (acceptable — the old data had no
-- per-admin attribution to recover).

ALTER TABLE crm_notifications
    ADD COLUMN IF NOT EXISTS read_by JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Seed a sentinel marker on already-read rows so they stay out of unread feeds.
UPDATE crm_notifications
   SET read_by = '["__legacy_global_read__"]'::jsonb
 WHERE read_at IS NOT NULL
   AND read_by = '[]'::jsonb;

-- Drop the old unread index keyed on read_at; unread is now per-admin and
-- cannot be expressed as a partial index, so a plain recent index suffices.
DROP INDEX IF EXISTS idx_crm_notifications_unread_recent;
