-- 107_repoint_banner_promo_created_by_to_crm_admins.sql
-- banners.created_by (migration 006) and promotions.created_by (migration
-- 007) were defined pre-CRM-v2 with FK -> users(id). Both create handlers
-- stamp crm_admins.id from the JWT (jwt.go:68, validated against
-- crm_admins). CRM v2 admin ids are NOT in users, so every banner/promo
-- create hit a 23503 FK violation (banners_created_by_fkey /
-- promotions_created_by_fkey).
--
-- 041 extended both tables with CRM v2 columns but never repointed the
-- owner FK — an oversight. Every other CRM v2 table (039/040/041/046/
-- 103/104) uses `created_by UUID REFERENCES crm_admins(id) ON DELETE SET
-- NULL`. This migration brings banners + promotions onto that convention.
--
-- Forward-only per repo policy. No .down.sql. Idempotent (DROP ... IF
-- EXISTS + guarded re-add) so it is safe to re-run.

-- Pre-flight: orphan any created_by that is not a valid crm_admins.id
-- (expected zero rows — create currently fails, so nothing was inserted).
UPDATE banners
   SET created_by = NULL
 WHERE created_by IS NOT NULL
   AND created_by NOT IN (SELECT id FROM crm_admins);

UPDATE promotions
   SET created_by = NULL
 WHERE created_by IS NOT NULL
   AND created_by NOT IN (SELECT id FROM crm_admins);

-- banners.created_by -> crm_admins(id)
ALTER TABLE banners
    DROP CONSTRAINT IF EXISTS banners_created_by_fkey;
ALTER TABLE banners
    ADD CONSTRAINT banners_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES crm_admins(id) ON DELETE SET NULL;

-- promotions.created_by -> crm_admins(id)
ALTER TABLE promotions
    DROP CONSTRAINT IF EXISTS promotions_created_by_fkey;
ALTER TABLE promotions
    ADD CONSTRAINT promotions_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES crm_admins(id) ON DELETE SET NULL;
