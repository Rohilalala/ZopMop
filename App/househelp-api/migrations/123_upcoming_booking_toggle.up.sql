-- 123_upcoming_booking_toggle: append the upcoming_booking section to the active home config.
-- Idempotent: only fires while no upcoming_booking section is present yet.
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json, '{sections}',
         (config_json->'sections')
           || ('[{"id":"upcoming_booking","type":"upcoming_booking","visible":true,"data":{"visible":true}}]'::jsonb))
 WHERE page_id='home' AND env='production' AND status='active'
   AND NOT (config_json->'sections') @> '[{"type":"upcoming_booking"}]'::jsonb;
