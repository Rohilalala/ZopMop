package booking

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// seedUser inserts a minimal users row (bookings.helper_id FKs users(id)) and
// registers cleanup. role is 'pro' or 'customer'.
func seedUser(t *testing.T, pool *pgxpool.Pool, id, role string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, phone, name, role) VALUES ($1::uuid, $2, 'OTP Test', $3)`,
		id, uniquePhone(), role); err != nil {
		t.Fatalf("seed user %s: %v", role, err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id=$1::uuid`, id) })
}

// Customer reading their own booking sees start_otp always and end_otp only
// once paid. The pro (helper) reading the same booking never sees either.
func TestGetBookingByID_OTPExposure(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()
	repo := NewRepository(pool)

	customer := makeUUID(t, "otp-cust")
	bookingID := seedPendingBooking(t, pool, customer, 10000)

	// Read OTP values directly to compare against the exposed payload.
	var startCode, endCode string
	if err := pool.QueryRow(ctx, `SELECT start_otp, end_otp FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&startCode, &endCode); err != nil {
		t.Fatalf("read raw otps: %v", err)
	}

	// Unpaid customer read: start_otp present, end_otp hidden.
	b, err := repo.GetBookingByID(ctx, bookingID, customer)
	if err != nil {
		t.Fatalf("customer GetBookingByID: %v", err)
	}
	if b.StartOTP == nil || *b.StartOTP != startCode {
		t.Fatalf("customer start_otp = %v, want %q", b.StartOTP, startCode)
	}
	if b.EndOTP != nil {
		t.Fatalf("unpaid customer end_otp = %v, want nil", *b.EndOTP)
	}

	// Mark paid → end_otp now exposed to customer.
	if _, err := pool.Exec(ctx, `UPDATE bookings SET payment_status='paid' WHERE id=$1::uuid`, bookingID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	b2, err := repo.GetBookingByID(ctx, bookingID, customer)
	if err != nil {
		t.Fatalf("customer GetBookingByID (paid): %v", err)
	}
	if b2.EndOTP == nil || *b2.EndOTP != endCode {
		t.Fatalf("paid customer end_otp = %v, want %q", b2.EndOTP, endCode)
	}

	// Pro (helper) read of the same paid booking: BOTH OTPs nil.
	helper := makeUUID(t, "otp-pro")
	seedUser(t, pool, helper, "pro")
	if _, err := pool.Exec(ctx, `UPDATE bookings SET helper_id=$2::uuid WHERE id=$1::uuid`, bookingID, helper); err != nil {
		t.Fatalf("assign helper: %v", err)
	}
	bp, err := repo.GetBookingByID(ctx, bookingID, helper)
	if err != nil {
		t.Fatalf("pro GetBookingByID: %v", err)
	}
	if bp.StartOTP != nil || bp.EndOTP != nil {
		t.Fatalf("pro saw otp values: start=%v end=%v, want both nil", bp.StartOTP, bp.EndOTP)
	}
}

// StartBooking requires the correct START OTP. Wrong code → no transition,
// attempt counter increments. Right code → in_progress + start_verified_at set.
func TestStartBooking_OTPGate(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()

	customer := makeUUID(t, "start-cust")
	helper := makeUUID(t, "start-pro")
	seedUser(t, pool, helper, "pro")
	bookingID := seedPendingBooking(t, pool, customer, 10000)
	// Move to 'accepted' with this helper assigned (start precondition).
	if _, err := pool.Exec(ctx,
		`UPDATE bookings SET helper_id=$2::uuid, status='accepted', accepted_at=now() WHERE id=$1::uuid`,
		bookingID, helper); err != nil {
		t.Fatalf("set accepted: %v", err)
	}
	var code string
	if err := pool.QueryRow(ctx, `SELECT start_otp FROM bookings WHERE id=$1::uuid`, bookingID).Scan(&code); err != nil {
		t.Fatalf("read start_otp: %v", err)
	}
	svc := NewService(NewRepository(pool), pool, nil, nil, nil)

	// Wrong OTP → ErrInvalidOTP, status unchanged, attempts incremented.
	wrong := "0000"
	if code == "0000" {
		wrong = "1111"
	}
	if err := svc.StartBooking(ctx, bookingID, helper, wrong); err != ErrInvalidOTP {
		t.Fatalf("wrong otp err = %v, want ErrInvalidOTP", err)
	}
	var status string
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT status, start_otp_attempts FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&status, &attempts); err != nil {
		t.Fatalf("read after wrong: %v", err)
	}
	if status != "accepted" || attempts != 1 {
		t.Fatalf("after wrong otp: status=%s attempts=%d, want accepted/1", status, attempts)
	}

	// Correct OTP → in_progress, start_verified_at set.
	if err := svc.StartBooking(ctx, bookingID, helper, code); err != nil {
		t.Fatalf("correct otp StartBooking: %v", err)
	}
	var verified *string
	if err := pool.QueryRow(ctx, `SELECT status, start_verified_at::text FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&status, &verified); err != nil {
		t.Fatalf("read after correct: %v", err)
	}
	if status != "in_progress" || verified == nil {
		t.Fatalf("after correct otp: status=%s verified=%v, want in_progress/non-nil", status, verified)
	}
}

// CompleteBooking gates on payment THEN END OTP. Unpaid → ErrPaymentRequired
// (even with a correct-looking code). Paid + wrong → ErrInvalidOTP. Paid +
// right → completed.
func TestCompleteBooking_PaymentAndOTPGate(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()

	customer := makeUUID(t, "cmp-cust")
	helper := makeUUID(t, "cmp-pro")
	seedUser(t, pool, helper, "pro")
	bookingID := seedPendingBooking(t, pool, customer, 10000)
	if _, err := pool.Exec(ctx,
		`UPDATE bookings SET helper_id=$2::uuid, status='in_progress', started_at=now(),
		        payment_method='cod' WHERE id=$1::uuid`,
		bookingID, helper); err != nil {
		t.Fatalf("set in_progress cod unpaid: %v", err)
	}
	var code string
	if err := pool.QueryRow(ctx, `SELECT end_otp FROM bookings WHERE id=$1::uuid`, bookingID).Scan(&code); err != nil {
		t.Fatalf("read end_otp: %v", err)
	}
	svc := NewService(NewRepository(pool), pool, nil, nil, nil)

	// Unpaid → ErrPaymentRequired regardless of code.
	if err := svc.CompleteBooking(ctx, bookingID, helper, code); err != ErrPaymentRequired {
		t.Fatalf("unpaid complete err = %v, want ErrPaymentRequired", err)
	}

	// Mark paid.
	if _, err := pool.Exec(ctx, `UPDATE bookings SET payment_status='paid' WHERE id=$1::uuid`, bookingID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	// Paid + wrong → ErrInvalidOTP.
	wrong := "0000"
	if code == "0000" {
		wrong = "1111"
	}
	if err := svc.CompleteBooking(ctx, bookingID, helper, wrong); err != ErrInvalidOTP {
		t.Fatalf("paid+wrong err = %v, want ErrInvalidOTP", err)
	}
	// Paid + right → completed.
	if err := svc.CompleteBooking(ctx, bookingID, helper, code); err != nil {
		t.Fatalf("paid+right complete: %v", err)
	}
	var status string
	var endVerified *string
	if err := pool.QueryRow(ctx, `SELECT status, end_verified_at::text FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&status, &endVerified); err != nil {
		t.Fatalf("read after complete: %v", err)
	}
	if status != "completed" || endVerified == nil {
		t.Fatalf("after complete: status=%s endVerified=%v, want completed/non-nil", status, endVerified)
	}
}

// CollectCash flips a COD in_progress booking to paid, writes a cash payment
// row for the outstanding net, and emits booking.paid. END OTP then becomes
// visible to the customer.
func TestCollectCash(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()

	customer := makeUUID(t, "cash-cust")
	helper := makeUUID(t, "cash-pro")
	seedUser(t, pool, helper, "pro")
	// net = amount(10000) - discount(0) - wallet_applied(2000) = 8000
	bookingID := seedPendingBooking(t, pool, customer, 10000)
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM event_outbox WHERE aggregate_id=$1::uuid`, bookingID) })
	if _, err := pool.Exec(ctx,
		`UPDATE bookings SET helper_id=$2::uuid, status='in_progress', started_at=now(),
		        payment_method='cod', wallet_applied_paise=2000 WHERE id=$1::uuid`,
		bookingID, helper); err != nil {
		t.Fatalf("set in_progress cod: %v", err)
	}
	svc := NewService(NewRepository(pool), pool, nil, nil, nil)

	outstanding, err := svc.CollectCash(ctx, bookingID, helper)
	if err != nil {
		t.Fatalf("CollectCash: %v", err)
	}
	if outstanding != 0 {
		t.Fatalf("returned outstanding = %d, want 0", outstanding)
	}

	var payStatus string
	if err := pool.QueryRow(ctx, `SELECT payment_status FROM bookings WHERE id=$1::uuid`, bookingID).Scan(&payStatus); err != nil {
		t.Fatalf("read payment_status: %v", err)
	}
	if payStatus != "paid" {
		t.Fatalf("payment_status = %s, want paid", payStatus)
	}

	var cashAmt int64
	if err := pool.QueryRow(ctx,
		`SELECT amount_paise FROM payments WHERE booking_id=$1::uuid AND gateway='cash' AND gateway_status='success'`,
		bookingID).Scan(&cashAmt); err != nil {
		t.Fatalf("read cash payment row: %v", err)
	}
	if cashAmt != 8000 {
		t.Fatalf("cash amount = %d, want 8000 (net of wallet)", cashAmt)
	}

	var evtCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM event_outbox WHERE event_type='booking.paid' AND aggregate_id=$1::uuid`,
		bookingID).Scan(&evtCount); err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	if evtCount != 1 {
		t.Fatalf("booking.paid events = %d, want 1", evtCount)
	}

	// Second call is a no-op error (already paid).
	if _, err := svc.CollectCash(ctx, bookingID, helper); err == nil {
		t.Fatalf("second CollectCash should error (already paid)")
	}
}
