-- Idempotent re-rename. After the 2026-05-14 incident migration 090 was
-- partially reverted on prod (price_paise -> price_cents) so the live code
-- kept working. Environments that already ran 090 cleanly have price_paise
-- and need this to be a no-op. Environments still on price_cents (prod, as
-- of the incident) get the rename. Either way the column ends up named
-- price_paise.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'booking_services'
      AND column_name = 'price_cents'
  ) THEN
    EXECUTE 'ALTER TABLE booking_services RENAME COLUMN price_cents TO price_paise';
  END IF;
END
$$;
-- Type stays BIGINT (already widened by 090).
