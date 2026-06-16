-- Force-update support: per-policy store links for the app's "Update now" button.
-- The app's version-check endpoint returns the platform-appropriate URL so the
-- store target is admin-configurable (no app rebuild needed to change it).
-- Numbered 140 to sit after the unified-slot branch's reserved 136–139.
ALTER TABLE crm_app_versions
  ADD COLUMN IF NOT EXISTS ios_store_url     TEXT,
  ADD COLUMN IF NOT EXISTS android_store_url TEXT;
