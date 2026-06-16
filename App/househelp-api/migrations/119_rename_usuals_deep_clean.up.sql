-- 119_rename_usuals_deep_clean
-- "Deep clean" isn't a real catalog service. The instant usuals slot points at
-- service …0001 after migration 118, so label it with the canonical catalog
-- name "Sweeping and Mopping" (consistency with service_categories).
-- Guarded by the slot id + idempotent (re-run is a no-op).
UPDATE sdui_page_configs
   SET config_json = jsonb_set(
         config_json,
         '{sections,1,data,services,1,name}',
         '"Sweeping and Mopping"')
 WHERE page_id = 'home'
   AND env     = 'production'
   AND status  = 'active'
   AND config_json #>> '{sections,1,data,services,1,id}'   = 'a1000000-0000-0000-0000-000000000001'
   AND config_json #>> '{sections,1,data,services,1,name}' <> 'Sweeping and Mopping';
