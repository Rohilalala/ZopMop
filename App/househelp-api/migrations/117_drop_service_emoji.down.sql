-- Restore the service emoji column (nullable). Values are not recovered.
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS emoji TEXT;
