-- 068_payments_nullable_booking.sql
-- Wallet topups create a payments row that is not tied to a booking. The
-- original 056_payments.sql declared payments.booking_id NOT NULL on the
-- assumption that every charge backed an order. Closed-loop wallet topups
-- break that assumption: amount lands in wallets.balance_paise, no booking
-- is created.
--
-- Drop the NOT NULL. Service-layer code (see internal/payments/handler.go,
-- internal/wallet/service.go) enforces:
--   gateway='cashfree' AND booking_id IS NULL → must have a corresponding
--                                                wallet_transactions row
--                                                with kind='topup'.
-- Existing rows are unaffected (NOT NULL → NULL is always safe).

ALTER TABLE payments
  ALTER COLUMN booking_id DROP NOT NULL;
