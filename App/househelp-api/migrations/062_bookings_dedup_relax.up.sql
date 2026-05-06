-- 062_bookings_dedup_relax.sql
-- Relax the booking dedup trigger introduced in 060.
--
-- Old behaviour: blocked any non-cancelled booking in the same category for
-- 1 hour. That stopped real users — once their first booking was accepted /
-- in-progress / completed they still couldn't book the same category again,
-- which is a legitimate flow (book another cleaning later in the day).
--
-- New behaviour: only block when the prior booking is still 'pending' AND
-- was created in the last 2 minutes. That covers the original concern
-- (double-tap, network retry without idempotency key, runaway client) but
-- gets out of the way for everything else.

CREATE OR REPLACE FUNCTION fn_bookings_reject_dup_within_hour() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'pending' AND EXISTS (
    SELECT 1 FROM bookings
    WHERE customer_id         = NEW.customer_id
      AND service_category_id = NEW.service_category_id
      AND status              = 'pending'
      AND created_at          >= NEW.created_at - interval '2 minutes'
      AND created_at          <  NEW.created_at + interval '2 minutes'
      AND id                  <> NEW.id
  ) THEN
    RAISE EXCEPTION 'duplicate pending booking within 2 minutes for same customer + category'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
