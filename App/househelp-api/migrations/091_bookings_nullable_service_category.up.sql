-- For multi-line cart bookings, service_category_id is meaningless.
-- Make it nullable. Existing rows keep their value.
ALTER TABLE bookings ALTER COLUMN service_category_id DROP NOT NULL;

-- Add a derived label column for human-readable summary on listing screens.
-- e.g. "Daily Essentials + Bathroom" — populated at booking creation time.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS summary_label TEXT;
