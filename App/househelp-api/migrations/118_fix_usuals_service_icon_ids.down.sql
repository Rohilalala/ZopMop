-- Revert 118: restore the original (buggy) usuals service ids.
-- Bathroom: …0002 → …0004
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections,1,data,services,4,id}',
         '"a1000000-0000-0000-0000-000000000004"')
 WHERE page_id = 'home'
   AND env     = 'production'
   AND status  = 'active'
   AND config_json #>> '{sections,1,data,services,4,name}' = 'Bathroom'
   AND config_json #>> '{sections,1,data,services,4,id}'   = 'a1000000-0000-0000-0000-000000000002';

-- Deep clean: …0001 → …0002
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections,1,data,services,1,id}',
         '"a1000000-0000-0000-0000-000000000002"')
 WHERE page_id = 'home'
   AND env     = 'production'
   AND status  = 'active'
   AND config_json #>> '{sections,1,data,services,1,name}' = 'Deep clean'
   AND config_json #>> '{sections,1,data,services,1,id}'   = 'a1000000-0000-0000-0000-000000000001';
