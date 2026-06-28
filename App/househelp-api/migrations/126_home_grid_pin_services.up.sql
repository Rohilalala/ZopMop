-- 126_home_grid_pin_services.sql
-- Pin the home "Popular services" grid to the five configured services.
--
-- 125 pointed the grid at {"$ref": "services.popular"}, which hydrates the
-- whole active catalog (17 services) — config lost control of membership.
-- The resolver now supports an optional $ids filter on $ref nodes: the config
-- names which ids render (and their order) while every value (price, rating,
-- duration) stays live from the catalog. This sets the grid back to the same
-- five services migration 036 chose, in the same display order.
--
-- Forward-only (repo policy: no .down.sql). Locates the grid by section id,
-- not array position. Idempotent: re-running writes the same node.

UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections}',
         (
           SELECT jsonb_agg(
                    CASE
                      WHEN sec->>'id' = 'popular'
                      THEN jsonb_set(sec, '{data,services}', '{
                             "$ref": "services.popular",
                             "$ids": [
                               "a1000000-0000-0000-0000-000000000002",
                               "a1000000-0000-0000-0000-000000000001",
                               "a1000000-0000-0000-0000-000000000003",
                               "a1000000-0000-0000-0000-000000000004",
                               "a1000000-0000-0000-0000-000000000005"
                             ]
                           }'::jsonb)
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
