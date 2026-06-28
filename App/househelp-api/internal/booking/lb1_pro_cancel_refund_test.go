package booking

import (
	"context"
	"testing"

	"github.com/adityarohilla/househelp-api/internal/wallet"
)

// LB-1: a terminal pro cancellation of a PAID booking must fully refund the
// customer. Previously the shift pro-cancel path stamped the booking cancelled
// with no refund, stranding the prepaid customer's money. CancelAndRefundAsPro
// mirrors the customer cancel money path with fee=0.
func TestCancelAndRefundAsPro_PaidCashfree_RecordsFullRefund(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()

	customer := makeUUID(t, "lb1-cust")
	bookingID := seedPendingBooking(t, pool, customer, 13000 /*net*/)
	w := wallet.NewService(wallet.NewRepository(pool))
	svc := newSplitTestService(t, pool, w)

	// Make it an accepted booking paid in full via Cashfree.
	if _, err := pool.Exec(ctx,
		`UPDATE bookings SET status='accepted', payment_method='cashfree', payment_status='paid' WHERE id=$1::uuid`,
		bookingID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM pending_refunds WHERE booking_id=$1::uuid`, bookingID) })

	proID := makeUUID(t, "pro")
	custID, err := svc.CancelAndRefundAsPro(ctx, bookingID, proID)
	if err != nil {
		t.Fatalf("CancelAndRefundAsPro: %v", err)
	}
	if custID != customer {
		t.Errorf("customerID = %s, want %s", custID, customer)
	}

	// Booking is cancelled, attributed to the pro, no fee withheld.
	var status, cancelledBy string
	var feeCents int64
	if err := pool.QueryRow(ctx,
		`SELECT status, COALESCE(cancelled_by,''), COALESCE(cancellation_fee_cents,0) FROM bookings WHERE id=$1::uuid`,
		bookingID).Scan(&status, &cancelledBy, &feeCents); err != nil {
		t.Fatalf("read booking: %v", err)
	}
	if status != "cancelled" || cancelledBy != "pro" || feeCents != 0 {
		t.Errorf("booking status=%s cancelled_by=%s fee=%d, want cancelled/pro/0", status, cancelledBy, feeCents)
	}

	// A single pending_refunds row for the full amount (cashfree rail).
	var refundCount int
	var refundCents int64
	if err := pool.QueryRow(ctx,
		`SELECT count(*), COALESCE(sum(amount_cents),0) FROM pending_refunds WHERE booking_id=$1::uuid AND status='pending'`,
		bookingID).Scan(&refundCount, &refundCents); err != nil {
		t.Fatalf("read pending_refunds: %v", err)
	}
	if refundCount != 1 || refundCents != 13000 {
		t.Errorf("pending_refunds count=%d cents=%d, want 1/13000", refundCount, refundCents)
	}

	// Idempotency: a second pro-cancel must error (already cancelled) and must
	// NOT create a second refund.
	if _, err := svc.CancelAndRefundAsPro(ctx, bookingID, proID); err == nil {
		t.Error("second CancelAndRefundAsPro should error on an already-cancelled booking")
	}
	var refundCount2 int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM pending_refunds WHERE booking_id=$1::uuid`, bookingID).Scan(&refundCount2); err != nil {
		t.Fatalf("recount pending_refunds: %v", err)
	}
	if refundCount2 != 1 {
		t.Errorf("double-cancel produced %d refund rows, want 1 (no double refund)", refundCount2)
	}
}

// An unpaid/COD pro-cancel cancels the booking but records no refund (nothing
// was collected) — and must not error.
func TestCancelAndRefundAsPro_Unpaid_NoRefund(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()

	customer := makeUUID(t, "lb1-unpaid")
	bookingID := seedPendingBooking(t, pool, customer, 9000)
	w := wallet.NewService(wallet.NewRepository(pool))
	svc := newSplitTestService(t, pool, w)
	if _, err := pool.Exec(ctx, `UPDATE bookings SET status='accepted' WHERE id=$1::uuid`, bookingID); err != nil {
		t.Fatalf("accept booking: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM pending_refunds WHERE booking_id=$1::uuid`, bookingID) })

	if _, err := svc.CancelAndRefundAsPro(ctx, bookingID, makeUUID(t, "pro")); err != nil {
		t.Fatalf("CancelAndRefundAsPro (unpaid): %v", err)
	}
	var status string
	pool.QueryRow(ctx, `SELECT status FROM bookings WHERE id=$1::uuid`, bookingID).Scan(&status)
	if status != "cancelled" {
		t.Errorf("status=%s, want cancelled", status)
	}
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM pending_refunds WHERE booking_id=$1::uuid`, bookingID).Scan(&n)
	if n != 0 {
		t.Errorf("unpaid cancel created %d refund rows, want 0", n)
	}
}
