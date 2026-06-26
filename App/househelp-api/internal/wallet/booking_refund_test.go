package wallet

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// R3: a PAID split booking is stamped payment_method='cashfree' but part of the
// net came from the wallet. Cancelling it must refund the wallet part to the
// wallet and only the gateway-charged remainder to Cashfree — not dump the whole
// net onto the Cashfree rail (over-refund) and strand the wallet money.
func TestRecordBookingRefundTx_PaidSplit_SplitsByRail(t *testing.T) {
	pool := openTestDB(t)
	ctx := context.Background()
	repo := NewRepository(pool)

	var customerID string
	ph := "9" + uuid.NewString()[:9]
	if err := pool.QueryRow(ctx, `INSERT INTO users(phone, role) VALUES ($1,'customer') RETURNING id::text`, ph).Scan(&customerID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM wallet_transactions WHERE user_id=$1::uuid`, customerID)
		pool.Exec(c, `DELETE FROM wallets WHERE user_id=$1::uuid`, customerID)
		pool.Exec(c, `DELETE FROM users WHERE id=$1::uuid`, customerID)
	})

	var svcCat string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM service_categories LIMIT 1`).Scan(&svcCat); err != nil {
		t.Skipf("no service_categories row to FK to: %v", err)
	}

	const net = int64(10000)         // ₹100 net
	const walletApplied = int64(3000) // ₹30 from wallet; ₹70 went to Cashfree
	var bookingID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO bookings
		  (customer_id, service_category_id, status, address, lat, lng,
		   amount_paise, payment_method, payment_status, wallet_applied_paise)
		VALUES ($1::uuid, $2::uuid, 'cancelled', 'x', 12.9, 77.6,
		        $3, 'cashfree', 'paid', $4)
		RETURNING id::text`, customerID, svcCat, net, walletApplied).Scan(&bookingID); err != nil {
		t.Fatalf("seed split booking: %v", err)
	}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM pending_refunds WHERE booking_id=$1::uuid`, bookingID)
		pool.Exec(c, `DELETE FROM bookings WHERE id=$1::uuid`, bookingID)
	})

	pm, ps, pid := "cashfree", "paid", "pay_test"
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		return RecordBookingRefundTx(ctx, tx, repo, customerID, bookingID, &pm, &pid, &ps, net, "test split refund")
	}); err != nil {
		t.Fatalf("RecordBookingRefundTx: %v", err)
	}

	// Wallet portion must be credited back (lazy wallet starts at 0 → now W).
	var balance int64
	if err := pool.QueryRow(ctx, `SELECT balance_paise FROM wallets WHERE user_id=$1::uuid`, customerID).Scan(&balance); err != nil {
		t.Fatalf("read wallet balance: %v", err)
	}
	if balance != walletApplied {
		t.Errorf("wallet balance = %d, want %d (the wallet portion refunded)", balance, walletApplied)
	}

	// Cashfree portion must be exactly net - walletApplied (not the whole net).
	var pendingAmt int64
	if err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(amount_cents),0) FROM pending_refunds WHERE booking_id=$1::uuid`, bookingID).Scan(&pendingAmt); err != nil {
		t.Fatalf("read pending_refunds: %v", err)
	}
	if pendingAmt != net-walletApplied {
		t.Errorf("Cashfree pending_refund = %d, want %d (net - wallet)", pendingAmt, net-walletApplied)
	}
}
