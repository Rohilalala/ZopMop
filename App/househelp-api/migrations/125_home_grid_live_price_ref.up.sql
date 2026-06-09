-- 125_home_grid_live_price_ref.sql
-- Make the home "Popular services" grid pull live catalog prices instead of the
-- marketing values inlined by migration 036.
--
-- 036 hardcoded each grid service (e.g. ₹299 base) into config_json. Those never
-- matched the live catalog (service_categories), which is what checkout charges
-- (₹25 base). To keep the home page in sync with the catalog and with checkout,
-- replace the grid's inlined `data.services` array with a single $ref node:
-- {"$ref": "services.popular"}. The BFF resolver hydrates it from the live
-- catalog at request time (sources.go: "services.popular" -> []Service, which
-- serializes prices as base_price_paise / mrp_paise). Single source of truth.
--
-- Forward-only (repo policy: no .down.sql). Order-independent: locates the grid
-- by section id, not array position, so later section-reordering migrations
-- don't break it. Idempotent: re-running rewrites to the same $ref node.

UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections}',
         (
           SELECT jsonb_agg(
                    CASE
                      WHEN sec->>'id' = 'popular'
                      THEN jsonb_set(sec, '{data,services}', '{"$ref": "services.popular"}'::jsonb)
                      ELSE sec
                    END
                    ORDER BY ord
                  )
           FROM jsonb_array_elements(config_json -> 'sections') WITH ORDINALITY AS t(sec, ord)
         )
       )
 WHERE page_id = 'home'
   AND env     = 'production'
   AND status  = 'active'
   AND config_json -> 'sections' @> '[{"id": "popular"}]';
