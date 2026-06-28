-- 121_greeting_hero_section: prepend the greeting_hero section to the active home config.
-- Idempotent: only fires while no greeting_hero section is present yet.
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json, '{sections}',
         ('[{"id":"hero","type":"greeting_hero","visible":true,"data":{"title_lines":["Home,","handled."],"show_mascot":true}}]'::jsonb)
           || (config_json->'sections'))
 WHERE page_id='home' AND env='production' AND status='active'
   AND NOT (config_json->'sections') @> '[{"type":"greeting_hero"}]'::jsonb;
