-- 060_bookings_dedup.sql
-- Guards against the same customer accidentally placing two bookings for the
-- same service category within an hour (double-tap, network retry without
-- idempotency key, runaway client). Cancelled bookings are excluded so a
-- customer who cancels and rebooks immediately is not blocked.
--
-- Implemented as a BEFORE-INSERT trigger rather than a partial unique index
-- because date_trunc(text, timestamptz) is STABLE, not IMMUTABLE, and Postgres
-- forbids non-IMMUTABLE expressions in index keys. The trigger raises
-- unique_violation, which the booking handler will surface as 409 Conflict.

CREATE OR REPLACE FUNCTION fn_bookings_reject_dup_within_hour() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status <> 'cancelled' AND EXISTS (
    SELECT 1 FROM bookings
    WHERE customer_id         = NEW.customer_id
      AND service_category_id = NEW.service_category_id
      AND status              <> 'cancelled'
      AND created_at          >= NEW.created_at - interval '1 hour'
      AND created_at          <  NEW.created_at + interval '1 hour'
      AND id                  <> NEW.id
  ) THEN
    RAISE EXCEPTION 'duplicate booking within 1 hour for same customer + category'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bookings_reject_dup ON bookings;
CREATE TRIGGER trg_bookings_reject_dup
BEFORE INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION fn_bookings_reject_dup_within_hour();

-- Supporting index — the trigger's lookup is keyed on (customer, category)
-- and a small time window. Without an index this would seq-scan bookings on
-- every insert.
CREATE INDEX IF NOT EXISTS idx_bookings_dedup_lookup
  ON bookings (customer_id, service_category_id, created_at)
  WHERE status <> 'cancelled';
