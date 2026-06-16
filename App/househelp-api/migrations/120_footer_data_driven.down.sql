UPDATE sdui_page_configs
   SET config_json = jsonb_set(config_json, '{sections,3,data}', '{}'::jsonb)
 WHERE page_id = 'home' AND env = 'production' AND status = 'active'
   AND config_json #>> '{sections,3,type}' = 'footer';
