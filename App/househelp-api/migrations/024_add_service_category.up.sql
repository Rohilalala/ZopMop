-- 024_add_service_category.sql
-- Adds a category column to service_categories for admin grouping.

ALTER TABLE service_categories
    ADD COLUMN IF NOT EXISTS category VARCHAR(100) NOT NULL DEFAULT 'other';

-- Backfill category based on service name patterns.
UPDATE service_categories SET category = 'home_cleaning'
WHERE name ~* 'sweep|mop|dust|wipe|window|balcony|bathroom';

UPDATE service_categories SET category = 'kitchen'
WHERE name ~* 'kitchen|dish|utensil|fridge|cabinet';

UPDATE service_categories SET category = 'laundry'
WHERE name ~* 'laundry|iron|fold|wardrobe';

UPDATE service_categories SET category = 'outdoor'
WHERE name ~* 'garden|plant|outdoor';

UPDATE service_categories SET category = 'vehicle'
WHERE name ~* 'car|vehicle|bike';

UPDATE service_categories SET category = 'pet'
WHERE name ~* 'pet|dog|cat|walk';
