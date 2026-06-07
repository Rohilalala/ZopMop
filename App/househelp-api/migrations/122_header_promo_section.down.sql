-- 122_header_promo_section (down): remove the header_promo section from the active home config.
UPDATE sdui_page_configs
   SET config_json = jsonb_set(config_json, '{sections}',
         (SELECT coalesce(jsonb_agg(s), '[]'::jsonb)
            FROM jsonb_array_elements(config_json->'sections') s
           WHERE s->>'type' <> 'header_promo'))
 WHERE page_id='home' AND env='production' AND status='active';
