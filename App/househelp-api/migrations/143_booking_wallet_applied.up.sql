-- 143_booking_wallet_applied.up.sql
-- Split payment: amount of the booking net already covered from the customer's
-- wallet at create time. The Cashfree order for a split booking charges
-- (amount_paise - discount_paise - wallet_applied_paise). Forward-only (repo policy).
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS wallet_applied_paise BIGINT NOT NULL DEFAULT 0;
