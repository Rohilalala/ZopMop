-- 120_footer_data_driven: replace the empty footer data with the typed signoff shape.
-- Idempotent: only fires while the footer data has no signoff yet.
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections,3,data}',
         '{"signoff":{"lines":["We mop.","You zop."],"brand":"ZopMop","badges":["Vetted pros","30-min support","Refund if unhappy"],"tagline":"Built in India · One home at a time"}}'::jsonb)
 WHERE page_id = 'home' AND env = 'production' AND status = 'active'
   AND config_json #>> '{sections,3,type}'           = 'footer'
   AND config_json #>> '{sections,3,data,signoff}'   IS NULL;
