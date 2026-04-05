-- 021_add_helper_profile_fields.sql
-- Adds services offered, availability slots, and address to the helpers table.

ALTER TABLE helpers
  ADD COLUMN IF NOT EXISTS services     TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS availability TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS address      TEXT    NOT NULL DEFAULT '';
