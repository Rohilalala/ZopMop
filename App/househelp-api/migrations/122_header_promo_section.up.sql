-- 122_header_promo_section: prepend the header_promo section to the active home config.
-- Idempotent: only fires while no header_promo section is present yet.
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json, '{sections}',
         ('[{"id":"header_promo","type":"header_promo","visible":true,"data":{"label":"Earn ₹150","action":{"trigger":"tap","type":"navigate","screen":"ReferralEarn"},"visible":true}}]'::jsonb)
           || (config_json->'sections'))
 WHERE page_id='home' AND env='production' AND status='active'
   AND NOT (config_json->'sections') @> '[{"type":"header_promo"}]'::jsonb;
