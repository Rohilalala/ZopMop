-- 025_fix_service_data_and_add_constraints.sql
-- Restores all 18 seeded service categories to canonical values,
-- then adds DB-level CHECK constraints so name/price can never be
-- corrupted again regardless of what the application layer sends.
--
-- Run order matters: restore data FIRST, then add constraints.
-- (Constraints would reject empty-name/zero-price rows on ALTER.)

-- ── 1. Restore canonical data ─────────────────────────────────────────────────

UPDATE service_categories SET
    name='Sweeping & Mopping', emoji='🧹', bg_color='#EEF2FF',
    base_price_cents=2500, mrp_cents=12500, rating=4.9, review_count=15300,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=1, category='home_cleaning'
WHERE id='a1000000-0000-0000-0000-000000000001';

UPDATE service_categories SET
    name='Bathroom Cleaning', emoji='🚿', bg_color='#F0FDFA',
    base_price_cents=2500, mrp_cents=15000, rating=4.9, review_count=17800,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=2, category='home_cleaning'
WHERE id='a1000000-0000-0000-0000-000000000002';

UPDATE service_categories SET
    name='Utensils', emoji='🍽️', bg_color='#FFF7ED',
    base_price_cents=2500, mrp_cents=12500, rating=4.9, review_count=13500,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=3, category='kitchen'
WHERE id='a1000000-0000-0000-0000-000000000003';

UPDATE service_categories SET
    name='Dusting & Wiping', emoji='🧽', bg_color='#F0FDF4',
    base_price_cents=2500, mrp_cents=12500, rating=4.9, review_count=6500,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=4, category='home_cleaning'
WHERE id='a1000000-0000-0000-0000-000000000004';

UPDATE service_categories SET
    name='Kitchen Prep', emoji='🔪', bg_color='#EFF6FF',
    base_price_cents=2500, mrp_cents=12500, rating=4.9, review_count=3700,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=5, category='kitchen'
WHERE id='a1000000-0000-0000-0000-000000000005';

UPDATE service_categories SET
    name='Laundry', emoji='👕', bg_color='#FDF4FF',
    base_price_cents=2500, mrp_cents=12500, rating=4.9, review_count=4500,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=6, category='laundry'
WHERE id='a1000000-0000-0000-0000-000000000006';

UPDATE service_categories SET
    name='Window Cleaning', emoji='🪟', bg_color='#F8FAFC',
    base_price_cents=2500, mrp_cents=12500, rating=4.9, review_count=4200,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=7, category='home_cleaning'
WHERE id='a1000000-0000-0000-0000-000000000007';

UPDATE service_categories SET
    name='Fridge Cleaning', emoji='❄️', bg_color='#F0F9FF',
    base_price_cents=14900, mrp_cents=25000, rating=4.9, review_count=3300,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=8, category='kitchen'
WHERE id='a1000000-0000-0000-0000-000000000008';

UPDATE service_categories SET
    name='Ironing & Folding', emoji='🧺', bg_color='#FEF9C3',
    base_price_cents=2500, mrp_cents=12500, rating=4.8, review_count=4300,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=9, category='laundry'
WHERE id='a1000000-0000-0000-0000-000000000009';

UPDATE service_categories SET
    name='Balcony Cleaning', emoji='🏠', bg_color='#F0FDF4',
    base_price_cents=2500, mrp_cents=12500, rating=4.8, review_count=2800,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=10, category='home_cleaning'
WHERE id='a1000000-0000-0000-0000-000000000010';

UPDATE service_categories SET
    name='Event Cleaning', emoji='🎉', bg_color='#FFF7ED',
    base_price_cents=4900, mrp_cents=20000, rating=4.8, review_count=1200,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=11, category='other'
WHERE id='a1000000-0000-0000-0000-000000000011';

UPDATE service_categories SET
    name='Kitchen Cleaning', emoji='🫧', bg_color='#EFF6FF',
    base_price_cents=2500, mrp_cents=12500, rating=4.9, review_count=5100,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=12, category='kitchen'
WHERE id='a1000000-0000-0000-0000-000000000012';

UPDATE service_categories SET
    name='Cabinet Cleaning', emoji='🗄️', bg_color='#F8FAFC',
    base_price_cents=2500, mrp_cents=12500, rating=4.8, review_count=1900,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=13, category='kitchen'
WHERE id='a1000000-0000-0000-0000-000000000013';

UPDATE service_categories SET
    name='Wardrobe Organization', emoji='👔', bg_color='#F5F3FF',
    base_price_cents=2500, mrp_cents=12500, rating=4.8, review_count=2100,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=14, category='laundry'
WHERE id='a1000000-0000-0000-0000-000000000014';

UPDATE service_categories SET
    name='Car Cleaning', emoji='🚗', bg_color='#EFF6FF',
    base_price_cents=3900, mrp_cents=18000, rating=4.8, review_count=3400,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=15, category='vehicle'
WHERE id='a1000000-0000-0000-0000-000000000015';

UPDATE service_categories SET
    name='Dog Walking', emoji='🐕', bg_color='#FFF7ED',
    base_price_cents=1990, mrp_cents=8000, rating=4.9, review_count=4700,
    min_duration_minutes=30, max_duration_minutes=60, duration_step_minutes=30,
    is_active=true, display_order=16, category='pet'
WHERE id='a1000000-0000-0000-0000-000000000016';

UPDATE service_categories SET
    name='Gardening', emoji='🌱', bg_color='#F0FDF4',
    base_price_cents=3500, mrp_cents=15000, rating=4.8, review_count=1800,
    min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=15,
    is_active=true, display_order=17, category='outdoor'
WHERE id='a1000000-0000-0000-0000-000000000017';

UPDATE service_categories SET
    name='Plant Care', emoji='🪴', bg_color='#F0FDF4',
    base_price_cents=2500, mrp_cents=12500, rating=4.8, review_count=1500,
    min_duration_minutes=30, max_duration_minutes=60, duration_step_minutes=30,
    is_active=true, display_order=18, category='outdoor'
WHERE id='a1000000-0000-0000-0000-000000000018';

-- ── 2. Add guardrail constraints ──────────────────────────────────────────────
-- Drop first in case they already exist from a partial run.
ALTER TABLE service_categories
    DROP CONSTRAINT IF EXISTS service_name_not_empty,
    DROP CONSTRAINT IF EXISTS service_price_positive;

ALTER TABLE service_categories
    ADD CONSTRAINT service_name_not_empty CHECK (trim(name) != ''),
    ADD CONSTRAINT service_price_positive  CHECK (base_price_cents > 0);
