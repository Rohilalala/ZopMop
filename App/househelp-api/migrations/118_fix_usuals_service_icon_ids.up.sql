-- 118_fix_usuals_service_icon_ids
-- The seeded home "usuals_row" (Book in 30 seconds) had two service entries
-- pointing at the wrong service id, so the app resolved the wrong 3D icon:
--   • "Bathroom"   carried …0004 (Dusting & Wiping) → rendered the shelf icon.
--   • "Deep clean" carried …0002 (Bathroom cleaning) → rendered the bathroom icon.
-- Repoint them to the correct services:
--   • Bathroom   → …0002 (Bathroom cleaning)
--   • Deep clean → …0001 (Sweeping & Mopping)
-- Targeted + idempotent: the name guards make this a no-op on rows that don't
-- match the buggy seed shape, and re-running it changes nothing.

-- Bathroom: …0004 → …0002
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections,1,data,services,4,id}',
         '"a1000000-0000-0000-0000-000000000002"')
 WHERE page_id = 'home'
   AND env     = 'production'
   AND status  = 'active'
   AND config_json #>> '{sections,1,data,services,4,name}' = 'Bathroom'
   AND config_json #>> '{sections,1,data,services,4,id}'   = 'a1000000-0000-0000-0000-000000000004';

-- Deep clean: …0002 → …0001 (frees …0002 for Bathroom, avoids a duplicate id)
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections,1,data,services,1,id}',
         '"a1000000-0000-0000-0000-000000000001"')
 WHERE page_id = 'home'
   AND env     = 'production'
   AND status  = 'active'
   AND config_json #>> '{sections,1,data,services,1,name}' = 'Deep clean'
   AND config_json #>> '{sections,1,data,services,1,id}'   = 'a1000000-0000-0000-0000-000000000002';
