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
