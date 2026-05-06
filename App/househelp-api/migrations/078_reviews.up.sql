-- 078_reviews.up.sql
-- Customer-submitted ratings for completed bookings. helpers.rating is
-- recomputed via a trigger so consumers (matching score, CRM workers list)
-- don't need a separate query path.

CREATE TABLE IF NOT EXISTS reviews (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID         NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id UUID         NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  helper_id   UUID         NOT NULL REFERENCES helpers(id)   ON DELETE CASCADE,
  rating      SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_helper_created ON reviews (helper_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_customer       ON reviews (customer_id, created_at DESC);

-- Recompute helpers.rating as the average of all reviews for that helper.
-- Falls back to 5.00 (existing default) if the helper has no reviews yet —
-- new helpers should not appear with a 0-rating from an empty avg.
CREATE OR REPLACE FUNCTION fn_reviews_recompute_helper_rating() RETURNS TRIGGER AS $$
BEGIN
  UPDATE helpers
  SET rating = COALESCE((
    SELECT ROUND(AVG(rating)::numeric, 2)
    FROM reviews WHERE helper_id = NEW.helper_id
  ), 5.00)
  WHERE id = NEW.helper_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reviews_recompute_rating ON reviews;
CREATE TRIGGER trg_reviews_recompute_rating
AFTER INSERT OR UPDATE OF rating ON reviews
FOR EACH ROW EXECUTE FUNCTION fn_reviews_recompute_helper_rating();
