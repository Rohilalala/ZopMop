package payments

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fakeGateway struct {
	fail  bool
	calls int
}

func (f *fakeGateway) Refund(ctx context.Context, paymentID string, amountCents int64, method PaymentMethod, key string) (*RefundResult, error) {
	f.calls++
	if f.fail {
		return &RefundResult{StatusCode: 500}, errors.New("gateway boom")
	}
	return &RefundResult{GatewayRefundID: "rfnd_" + key, StatusCode: 200}, nil
}
func (f *fakeGateway) Name() string { return "fake" }

func openRefundTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed refund worker tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect test db: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedPendingRefund(t *testing.T, pool *pgxpool.Pool, method, paymentID, status string) string {
	t.Helper()
	ctx := context.Background()
	var userID string
	ph := "9" + uuid.NewString()[:9]
	if err := pool.QueryRow(ctx, `INSERT INTO users(phone, role) VALUES ($1,'customer') RETURNING id::text`, ph).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	var refundID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO pending_refunds (user_id, amount_cents, source, payment_method, payment_id, status)
		VALUES ($1::uuid, 7000, 'booking_cancellation', $2, $3, $4)
		RETURNING id::text`, userID, method, paymentID, status).Scan(&refundID); err != nil {
		t.Fatalf("seed pending_refund: %v", err)
	}
	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM pending_refunds WHERE id=$1::uuid`, refundID)
		pool.Exec(c, `DELETE FROM users WHERE id=$1::uuid`, userID)
	})
	return refundID
}

// A queued Cashfree refund must be driven against the gateway and marked
// processed — the gap that left prod cancellation refunds stranded.
func TestRefundWorker_ProcessesPendingCashfree(t *testing.T) {
	pool := openRefundTestDB(t)
	id := seedPendingRefund(t, pool, "cashfree", "order_abc", "pending")
	gw := &fakeGateway{}
	w := NewRefundWorker(pool, gw)

	proc, failed, err := w.ProcessOnce(context.Background(), 20)
	if err != nil {
		t.Fatalf("ProcessOnce: %v", err)
	}
	if gw.calls == 0 {
		t.Fatalf("gateway was not called (proc=%d failed=%d)", proc, failed)
	}
	var status string
	var gwRef *string
	if err := pool.QueryRow(context.Background(),
		`SELECT status, gateway_refund_id FROM pending_refunds WHERE id=$1::uuid`, id).Scan(&status, &gwRef); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if status != "processed" {
		t.Errorf("status = %s, want processed", status)
	}
	if gwRef == nil || *gwRef == "" {
		t.Error("gateway_refund_id not recorded")
	}
}

// A gateway failure must mark the row gateway_error (visible for retry), not
// silently drop it.
func TestRefundWorker_GatewayError_MarksGatewayError(t *testing.T) {
	pool := openRefundTestDB(t)
	id := seedPendingRefund(t, pool, "cashfree", "order_xyz", "pending")
	w := NewRefundWorker(pool, &fakeGateway{fail: true})

	_, failed, err := w.ProcessOnce(context.Background(), 20)
	if err != nil {
		t.Fatalf("ProcessOnce: %v", err)
	}
	if failed != 1 {
		t.Errorf("failed = %d, want 1", failed)
	}
	var status string
	pool.QueryRow(context.Background(),
		`SELECT status FROM pending_refunds WHERE id=$1::uuid`, id).Scan(&status)
	if status != "gateway_error" {
		t.Errorf("status = %s, want gateway_error", status)
	}
}

// Non-Cashfree rows (wallet refunds) must not be touched by the gateway worker.
func TestRefundWorker_SkipsNonCashfree(t *testing.T) {
	pool := openRefundTestDB(t)
	id := seedPendingRefund(t, pool, "wallet", "", "pending")
	gw := &fakeGateway{}
	w := NewRefundWorker(pool, gw)

	if _, _, err := w.ProcessOnce(context.Background(), 20); err != nil {
		t.Fatalf("ProcessOnce: %v", err)
	}
	if gw.calls != 0 {
		t.Errorf("gateway called %d times for a wallet refund; want 0", gw.calls)
	}
	var status string
	pool.QueryRow(context.Background(),
		`SELECT status FROM pending_refunds WHERE id=$1::uuid`, id).Scan(&status)
	if status != "pending" {
		t.Errorf("wallet refund status = %s, want untouched 'pending'", status)
	}
}
