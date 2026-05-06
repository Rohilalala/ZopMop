-- 036_seed_sdui_home.sql
-- Seeds an active SDUI home page config so the customer app renders without
-- requiring an admin upsert through the CRM. Mirrors static/safe_layouts/home.json
-- but stripped to PageConfig shape (config_hash / snapshot_at / config_version
-- are recomputed by the resolver each request).
--
-- Idempotent: archives any existing active home/production row that isn't this
-- one, then upserts the seed row. Re-running the migration is a no-op.

UPDATE sdui_page_configs
   SET status      = 'archived',
       archived_at = now(),
       archived_by = COALESCE(archived_by, 'seed-migration-036')
 WHERE page_id = 'home'
   AND env     = 'production'
   AND status  = 'active'
   AND version <> 'static-1.0';

INSERT INTO sdui_page_configs (
    page_id, version, env, status, schema_version, config_json,
    name, description, created_by, activated_by, activated_at
)
VALUES (
    'home',
    'static-1.0',
    'production',
    'active',
    1,
    $JSON$
{
  "page_id": "home",
  "version": "static-1.0",
  "min_client_version": "0.0.0",
  "schema_version": 1,
  "sections": [
    {
      "id": "live",
      "type": "live_pill",
      "visible": true,
      "data": {
        "nearby_count": {"$ref": "insights.nearby_count", "$default": 0},
        "avg_eta_min":  {"$ref": "insights.avg_eta_min",  "$default": 0},
        "avg_rating":   {"$ref": "insights.avg_rating",   "$default": 0}
      }
    },
    {
      "id": "usuals",
      "type": "usuals_row",
      "visible": true,
      "data": {
        "services": [
          {
            "id": "a1000000-0000-0000-0000-000000000001",
            "name": "Book instantly",
            "emoji": "⚡",
            "bg_color": "#EEF2FF",
            "base_price_cents": 24900,
            "mrp_cents": 49900,
            "rating": 4.9,
            "review_count": 15300,
            "min_duration_minutes": 30,
            "max_duration_minutes": 60,
            "duration_step_minutes": 15,
            "is_active": true,
            "display_order": 1
          },
          {
            "id": "a1000000-0000-0000-0000-000000000002",
            "name": "Deep clean",
            "emoji": "✨",
            "bg_color": "#F0FDFA",
            "base_price_cents": 59900,
            "mrp_cents": 99900,
            "rating": 4.9,
            "review_count": 17800,
            "min_duration_minutes": 90,
            "max_duration_minutes": 150,
            "duration_step_minutes": 30,
            "is_active": true,
            "display_order": 2
          },
          {
            "id": "a1000000-0000-0000-0000-000000000003",
            "name": "Dishes",
            "emoji": "🍽️",
            "bg_color": "#FFF7ED",
            "base_price_cents": 19900,
            "mrp_cents": 39900,
            "rating": 4.8,
            "review_count": 13500,
            "min_duration_minutes": 30,
            "max_duration_minutes": 60,
            "duration_step_minutes": 15,
            "is_active": true,
            "display_order": 3
          },
          {
            "id": "a1000000-0000-0000-0000-000000000006",
            "name": "Laundry",
            "emoji": "👕",
            "bg_color": "#FDF4FF",
            "base_price_cents": 34900,
            "mrp_cents": 49900,
            "rating": 4.9,
            "review_count": 4500,
            "min_duration_minutes": 60,
            "max_duration_minutes": 120,
            "duration_step_minutes": 30,
            "is_active": true,
            "display_order": 4
          },
          {
            "id": "a1000000-0000-0000-0000-000000000004",
            "name": "Bathroom",
            "emoji": "🚿",
            "bg_color": "#F0FDF4",
            "base_price_cents": 29900,
            "mrp_cents": 59900,
            "rating": 4.9,
            "review_count": 17800,
            "min_duration_minutes": 45,
            "max_duration_minutes": 90,
            "duration_step_minutes": 15,
            "is_active": true,
            "display_order": 5
          }
        ]
      }
    },
    {
      "id": "popular",
      "type": "service_grid",
      "visible": true,
      "data": {
        "title": "Popular services",
        "services": [
          {
            "id": "a1000000-0000-0000-0000-000000000002",
            "name": "Bathroom cleaning",
            "emoji": "🚿",
            "bg_color": "#F0FDFA",
            "base_price_cents": 29900,
            "mrp_cents": 59900,
            "rating": 4.9,
            "review_count": 17800,
            "min_duration_minutes": 30,
            "max_duration_minutes": 90,
            "duration_step_minutes": 15,
            "is_active": true,
            "display_order": 1
          },
          {
            "id": "a1000000-0000-0000-0000-000000000001",
            "name": "Sweeping & Mopping",
            "emoji": "🧹",
            "bg_color": "#EEF2FF",
            "base_price_cents": 24900,
            "mrp_cents": 49900,
            "rating": 4.9,
            "review_count": 15300,
            "min_duration_minutes": 30,
            "max_duration_minutes": 90,
            "duration_step_minutes": 15,
            "is_active": true,
            "display_order": 2
          },
          {
            "id": "a1000000-0000-0000-0000-000000000003",
            "name": "Utensils",
            "emoji": "🍽️",
            "bg_color": "#FFF7ED",
            "base_price_cents": 19900,
            "mrp_cents": 39900,
            "rating": 4.8,
            "review_count": 13500,
            "min_duration_minutes": 30,
            "max_duration_minutes": 90,
            "duration_step_minutes": 15,
            "is_active": true,
            "display_order": 3
          },
          {
            "id": "a1000000-0000-0000-0000-000000000004",
            "name": "Dusting & Wiping",
            "emoji": "🧽",
            "bg_color": "#F0FDF4",
            "base_price_cents": 24900,
            "mrp_cents": 39900,
            "rating": 4.9,
            "review_count": 6500,
            "min_duration_minutes": 30,
            "max_duration_minutes": 90,
            "duration_step_minutes": 15,
            "is_active": true,
            "display_order": 4
          },
          {
            "id": "a1000000-0000-0000-0000-000000000005",
            "name": "Kitchen Prep",
            "emoji": "🔪",
            "bg_color": "#EFF6FF",
            "base_price_cents": 24900,
            "mrp_cents": 39900,
            "rating": 4.9,
            "review_count": 3700,
            "min_duration_minutes": 30,
            "max_duration_minutes": 90,
            "duration_step_minutes": 15,
            "is_active": true,
            "display_order": 5
          }
        ],
        "has_more": false
      }
    },
    {
      "id": "footer",
      "type": "footer",
      "visible": true,
      "data": {}
    }
  ]
}
$JSON$::jsonb,
    'Static home seed',
    'Seeded by migration 036 — full home page driven from this row. CRM can publish a new draft to override.',
    'seed-migration-036',
    'seed-migration-036',
    now()
)
ON CONFLICT (page_id, version, env) DO UPDATE
   SET status        = 'active',
       config_json   = EXCLUDED.config_json,
       schema_version = EXCLUDED.schema_version,
       activated_by  = EXCLUDED.activated_by,
       activated_at  = now();
