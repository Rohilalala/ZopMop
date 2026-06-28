-- 124_fix_sdui_home_price_keys.sql
-- Data fix for the active SDUI home config seeded by migration 036.
--
-- 036 inlines each service's money fields as `base_price_cents` / `mrp_cents`,
-- but the mobile client reads `base_price_paise` / `mrp_paise`. The client got
-- undefined for the price and rendered ₹NaN on the home "Popular services" and
-- "usuals" cards. The stored values were always integer paise (e.g. 24900 =
-- ₹249) — only the JSON key name carried the legacy *_cents label the seed
-- missed. This renames the keys; values are unchanged.
--
-- Forward-only (repo policy: no .down.sql). Idempotent: only rows that still
-- carry the old keys are rewritten, so re-running is a no-op. Scoped to the
-- home page, which is the only SDUI config that inlines services.

UPDATE sdui_page_configs
   SET config_json = replace(
                       replace(config_json::text, 'base_price_cents', 'base_price_paise'),
                       'mrp_cents', 'mrp_paise'
                     )::jsonb
 WHERE page_id = 'home'
   AND config_json::text LIKE '%base_price_cents%';
