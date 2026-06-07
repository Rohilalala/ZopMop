-- Revert 119: restore the "Deep clean" label.
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections,1,data,services,1,name}',
         '"Deep clean"')
 WHERE page_id = 'home'
   AND env     = 'production'
   AND status  = 'active'
   AND config_json #>> '{sections,1,data,services,1,id}'   = 'a1000000-0000-0000-0000-000000000001'
   AND config_json #>> '{sections,1,data,services,1,name}' = 'Sweeping and Mopping';
