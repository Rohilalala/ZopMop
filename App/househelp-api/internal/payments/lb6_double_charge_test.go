package payments

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-backed guards for the LB-6 double-charge fix. Skipped when
// TEST_DATABASE_URL is unset. Requires migration 148.

func openLB6TestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping LB-6 DB test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect db: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// seedBookingLB6 inserts a user + a completed booking (completed bypasses the
// within-the-hour dedup trigger) and returns their ids. Cleaned up by Cleanup.
func seedBookingLB6(t *testing.T, pool *pgxpool.Pool) (bookingID, userID string) {
	t.Helper()
	ctx := context.Background()
	userID = uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone, role) VALUES ($1::uuid,$2,'customer')`, userID, "lb6:"+userID[:8]); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	var scID string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM service_categories LIMIT 1`).Scan(&scID); err != nil {
		t.Skipf("no service_categories row: %v", err)
	}
	bookingID = uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO bookings (id, customer_id, service_category_id, address, lat, lng, amount_paise, status)
		VALUES ($1::uuid,$2::uuid,$3::uuid,'a',12.9,77.6,10000,'completed')
	`, bookingID, userID, scID); err != nil {
		t.Fatalf("insert booking: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM payments WHERE booking_id=$1::uuid`, bookingID)
		_, _ = pool.Exec(ctx, `DELETE FROM bookings WHERE id=$1::uuid`, bookingID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id=$1::uuid`, userID)
	})
	return bookingID, userID
}

// A second pending Cashfree order for the same booking must be rejected by
// uq_payments_pending_cashfree_per_booking, and the error recognised so the
// handler reuses the winner's order instead of charging twice.
func TestLB6_SecondPendingCashfreeOrderRejected(t *testing.T) {
	pool := openLB6TestDB(t)
	ledger := NewLedger(pool)
	ctx := context.Background()
	bookingID, userID := seedBookingLB6(t, pool)

	if _, err := ledger.CreatePayment(ctx, &bookingID, userID, 10000, "cashfree", nil); err != nil {
		t.Fatalf("first CreatePayment: %v", err)
	}
	_, err := ledger.CreatePayment(ctx, &bookingID, userID, 10000, "cashfree", nil)
	if err == nil {
		t.Fatal("second pending cashfree order was allowed — double-charge guard missing (migration 148 applied?)")
	}
	if !isUniquePendingCashfreeViolation(err) {
		t.Fatalf("error not recognised as the LB-6 unique violation: %v", err)
	}
}

// A pending row with no live cashfree_orders (gateway died mid-create, or the
// order expired) must be failed-out by expireStalePendingCashfree so the
// customer can open a fresh order — otherwise the unique index locks them out.
func TestLB6_ExpireStaleFreesOrphanPendingRow(t *testing.T) {
	pool := openLB6TestDB(t)
	h := &Handler{db: pool, ledger: NewLedger(pool)}
	ctx := context.Background()
	bookingID, userID := seedBookingLB6(t, pool)

	if _, err := h.ledger.CreatePayment(ctx, &bookingID, userID, 10000, "cashfree", nil); err != nil {
		t.Fatalf("seed orphan pending: %v", err)
	}
	// Orphan currently blocks a new order.
	if _, err := h.ledger.CreatePayment(ctx, &bookingID, userID, 10000, "cashfree", nil); err == nil {
		t.Fatal("expected the orphan pending row to block a new order")
	}
	if err := h.expireStalePendingCashfree(ctx, bookingID); err != nil {
		t.Fatalf("expireStalePendingCashfree: %v", err)
	}
	if _, err := h.ledger.CreatePayment(ctx, &bookingID, userID, 10000, "cashfree", nil); err != nil {
		t.Fatalf("fresh order after expiring the stale row should succeed: %v", err)
	}
}
