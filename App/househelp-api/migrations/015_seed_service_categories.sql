-- 015_seed_service_categories.sql
-- Seeds the 9 core service categories with fixed UUIDs so the
-- mobile app's static fallback IDs match the database.

INSERT INTO service_categories
    (id, name, emoji, bg_color, base_price_cents, mrp_cents,
     rating, review_count,
     min_duration_minutes, max_duration_minutes, duration_step_minutes,
     is_active, display_order)
VALUES
    ('a1000000-0000-0000-0000-000000000001', 'Sweeping & Mopping',  '🧹', '#EEF2FF', 2500,  12500, 4.9, 15300, 30, 90, 15, true, 1),
    ('a1000000-0000-0000-0000-000000000002', 'Bathroom Cleaning',   '🚿', '#F0FDFA', 2500,  15000, 4.9, 17800, 30, 90, 15, true, 2),
    ('a1000000-0000-0000-0000-000000000003', 'Utensils',            '🍽️','#FFF7ED', 2500,  12500, 4.9, 13500, 30, 90, 15, true, 3),
    ('a1000000-0000-0000-0000-000000000004', 'Dusting & Wiping',   '🧽', '#F0FDF4', 2500,  12500, 4.9,  6500, 30, 90, 15, true, 4),
    ('a1000000-0000-0000-0000-000000000005', 'Kitchen Prep',        '🔪', '#EFF6FF', 2500,  12500, 4.9,  3700, 30, 90, 15, true, 5),
    ('a1000000-0000-0000-0000-000000000006', 'Laundry',             '👕', '#FDF4FF', 2500,  12500, 4.9,  4500, 30, 90, 15, true, 6),
    ('a1000000-0000-0000-0000-000000000007', 'Window Cleaning',     '🪟', '#F8FAFC', 2500,  12500, 4.9,  4200, 30, 90, 15, true, 7),
    ('a1000000-0000-0000-0000-000000000008', 'Fridge Cleaning',     '❄️', '#F0F9FF', 14900, 25000, 4.9,  3300, 30, 90, 15, true, 8),
    ('a1000000-0000-0000-0000-000000000009', 'Ironing & Folding',   '🧺', '#FEF9C3', 2500,  12500, 4.8,  4300, 30, 90, 15, true, 9)
ON CONFLICT (id) DO NOTHING;
