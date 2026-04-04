-- 017_seed_additional_services.sql
-- Adds remaining services from the full catalog with fixed UUIDs.
-- display_order 10+ ensures these appear after the original top-9 on the API.

INSERT INTO service_categories
    (id, name, emoji, bg_color, base_price_cents, mrp_cents,
     rating, review_count,
     min_duration_minutes, max_duration_minutes, duration_step_minutes,
     is_active, display_order)
VALUES
    ('a1000000-0000-0000-0000-000000000010', 'Balcony Cleaning',       '🏠', '#F0FDF4', 2500,  12500, 4.8,  2800, 30, 90, 15, true, 10),
    ('a1000000-0000-0000-0000-000000000011', 'Event Cleaning',         '🎉', '#FFF7ED', 4900,  20000, 4.8,  1200, 30, 90, 15, true, 11),
    ('a1000000-0000-0000-0000-000000000012', 'Kitchen Cleaning',       '🫧', '#EFF6FF', 2500,  12500, 4.9,  5100, 30, 90, 15, true, 12),
    ('a1000000-0000-0000-0000-000000000013', 'Cabinet Cleaning',       '🗄️','#F8FAFC', 2500,  12500, 4.8,  1900, 30, 90, 15, true, 13),
    ('a1000000-0000-0000-0000-000000000014', 'Wardrobe Organization',  '👔', '#F5F3FF', 2500,  12500, 4.8,  2100, 30, 90, 15, true, 14),
    ('a1000000-0000-0000-0000-000000000015', 'Car Cleaning',           '🚗', '#EFF6FF', 3900,  18000, 4.8,  3400, 30, 90, 15, true, 15),
    ('a1000000-0000-0000-0000-000000000016', 'Dog Walking',            '🐕', '#FFF7ED', 1990,   8000, 4.9,  4700, 30, 60, 30, true, 16),
    ('a1000000-0000-0000-0000-000000000017', 'Gardening',              '🌱', '#F0FDF4', 3500,  15000, 4.8,  1800, 30, 90, 15, true, 17),
    ('a1000000-0000-0000-0000-000000000018', 'Plant Care',             '🪴', '#F0FDF4', 2500,  12500, 4.8,  1500, 30, 60, 30, true, 18)
ON CONFLICT (id) DO NOTHING;
