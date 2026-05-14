-- Forward-only repo policy per cmd/migrate/main.go:9. This down file exists for
-- tooling completeness only; do not run it as part of normal rollback.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'booking_services'
      AND column_name = 'price_paise'
  ) THEN
    EXECUTE 'ALTER TABLE booking_services RENAME COLUMN price_paise TO price_cents';
  END IF;
END
$$;
