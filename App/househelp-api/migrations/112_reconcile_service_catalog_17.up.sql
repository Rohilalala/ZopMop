-- 112_reconcile_service_catalog_17.up.sql
-- Service Catalog Rework — STEP 1 of 4 (data layer only).
--
-- Reconciles service_categories to the final 17-service catalog on the
-- 30/60/90-minute time-tiered model:
--   * standard tier  → min_duration_minutes=30, max=90, duration_step_minutes=30
--   * Party Cleanup → FIXED 90: min=90, max=90, step=0
--
-- Rules honoured:
--   * No Go / front-end / content / icon changes here (those are later steps).
--   * Existing rows keep their ids so booking/cart FK history is preserved.
--   * Off-list services are DEACTIVATED (is_active=false) — never deleted.
--   * Pricing for the 13 existing kept/renamed rows is left UNTOUCHED.
--   * The 4 genuinely-new services get a clearly-marked PLACEHOLDER price
--     (base_price_cents = 100 = ₹1). Real pricing is a separate decision.
--
-- End state: 17 active services (display_order 1..17), 5 deactivated, 22 rows total.

-- ── 1. KEEP+ALIGN — existing rows that already match a target service ──────────
-- Set the 30/60/90 tier + target display_order. Name, price, emoji, category
-- are intentionally left as-is.
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=1,  is_active=true WHERE id='a1000000-0000-0000-0000-000000000002'; -- Bathroom Cleaning
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=8,  is_active=true WHERE id='a1000000-0000-0000-0000-000000000006'; -- Laundry
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=9,  is_active=true WHERE id='a1000000-0000-0000-0000-000000000005'; -- Kitchen Prep
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=10, is_active=true WHERE id='a1000000-0000-0000-0000-000000000007'; -- Window Cleaning
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=11, is_active=true WHERE id='a1000000-0000-0000-0000-000000000012'; -- Kitchen Cleaning
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=12, is_active=true WHERE id='a1000000-0000-0000-0000-000000000010'; -- Balcony Cleaning
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=14, is_active=true WHERE id='a1000000-0000-0000-0000-000000000008'; -- Fridge Cleaning
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=15, is_active=true WHERE id='a1000000-0000-0000-0000-000000000014'; -- Wardrobe Organization
UPDATE service_categories SET min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=16, is_active=true WHERE id='a1000000-0000-0000-0000-000000000018'; -- Plant Care (was max=60/step=30)

-- ── 2. RENAME — same service, corrected name (id + FK history preserved) ───────
UPDATE service_categories SET name='Utensil Washing',      min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=2, is_active=true WHERE id='a1000000-0000-0000-0000-000000000003'; -- was 'Utensils'
UPDATE service_categories SET name='Sweeping and Mopping', min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=3, is_active=true WHERE id='a1000000-0000-0000-0000-000000000001'; -- was 'Sweeping & Mopping'
UPDATE service_categories SET name='Dusting',              min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=4, is_active=true WHERE id='a1000000-0000-0000-0000-000000000004'; -- was 'Dusting & Wiping'
UPDATE service_categories SET name='Ironing and Folding',  min_duration_minutes=30, max_duration_minutes=90, duration_step_minutes=30, display_order=7, is_active=true WHERE id='a1000000-0000-0000-0000-000000000009'; -- was 'Ironing & Folding'

-- ── 3. NEW — services with no existing row ────────────────────────────────────
-- PLACEHOLDER price (base_price_cents = 100 = ₹1, mrp_cents = 100). DO NOT treat
-- as real pricing — final prices are set in a later step. Emoji here are
-- provisional too; real icons are Step 3.
INSERT INTO service_categories
    (id, name, emoji, bg_color, base_price_cents, mrp_cents,
     min_duration_minutes, max_duration_minutes, duration_step_minutes,
     is_active, display_order, category)
VALUES
    ('a1000000-0000-0000-0000-000000000019', 'Packing',                  '📦', '#FFF7ED', 100, 100, 30, 90, 30, true, 5,  'other'),         -- PLACEHOLDER price
    ('a1000000-0000-0000-0000-000000000020', 'Unpacking',                '📭', '#EEF2FF', 100, 100, 30, 90, 30, true, 6,  'other'),         -- PLACEHOLDER price
    ('a1000000-0000-0000-0000-000000000021', 'Fan Cleaning',             '🪭', '#F0F9FF', 100, 100, 30, 90, 30, true, 13, 'home_cleaning'), -- PLACEHOLDER price
    ('a1000000-0000-0000-0000-000000000022', 'Party Cleanup',            '🎊', '#FDF4FF', 100, 100, 90, 90, 0,  true, 17, 'other')          -- PLACEHOLDER price; FIXED 90 min
ON CONFLICT (id) DO NOTHING;

-- ── 4. DEACTIVATE — real rows not in the final 17 (is_active=false only) ───────
-- Pricing, ids, and FK references are left intact so historical bookings,
-- cart_items, and booking_services keep resolving.
UPDATE service_categories SET is_active=false
WHERE id IN (
    'a1000000-0000-0000-0000-000000000011', -- Event Cleaning
    'a1000000-0000-0000-0000-000000000013', -- Cabinet Cleaning
    'a1000000-0000-0000-0000-000000000015', -- Car Cleaning
    'a1000000-0000-0000-0000-000000000016', -- Dog Walking
    'a1000000-0000-0000-0000-000000000017'  -- Gardening
);
