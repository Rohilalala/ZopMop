package booking

import (
	"context"
	"os"
	"testing"

	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/wallet"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-backed tests for the split-payment rail: payBookingSplit debits
// min(balance, net) from the customer's wallet in one tx, stamps
// wallet_applied_paise + payment_method='cashfree', and leaves the booking
// unpaid (payment_status NULL) for the Cashfree remainder. Skipped when
// TEST_DATABASE_URL is unset (mirrors capacity_test.go); point it at a
// Postgres with the full migration set (>= 143) applied.

func splitTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// makeUUID returns a fresh UUID for a fixture row. The label is cosmetic — it
// only documents which fixture the id belongs to at the call site.
func makeUUID(t *testing.T, _ string) string {
	t.Helper()
	return uuid.NewString()
}

// splitWalletAdapter bridges *wallet.Service to the booking package's
// WalletDebiter interface (the production adapter lives in package main, which
// tests can't import). Mirrors cmd/api/main.go:bookingWalletAdapter.
type splitWalletAdapter struct{ svc *wallet.Service }

func (a splitWalletAdapter) DebitTx(ctx context.Context, tx pgx.Tx, userID string, amountPaise int64, kind string, bookingID *string, note string) error {
	_, err := a.svc.DebitTx(ctx, tx, userID, amountPaise, wallet.Kind(kind), bookingID, note)
	return err
}

// seedPendingBooking inserts a customer user, a service category, and a minimal
// pending bookings row (amount_paise=net, status='pending'), returning the
// booking id. The booking row is required so the wallet spend's
// wallet_transactions.booking_id FK is satisfiable. Cleaned up at test end.
func seedPendingBooking(t *testing.T, pool *pgxpool.Pool, customerID string, netPaise int64) string {
	t.Helper()
	ctx := context.Background()

	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, phone, name, role) VALUES ($1::uuid, $2, 'Split Cust', 'customer')`,
		customerID, uniquePhone(),
	); err != nil {
		t.Fatalf("insert customer: %v", err)
	}

	var serviceID string
	if err := pool.QueryRow(ctx,
		`INSERT INTO service_categories (name, base_price_cents) VALUES ($1, 10000) RETURNING id::text`,
		"SplitSvc-"+customerID,
	).Scan(&serviceID); err != nil {
		t.Fatalf("insert service_category: %v", err)
	}

	var bookingID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO bookings (customer_id, service_category_id, status, address, lat, lng, amount_paise)
		VALUES ($1::uuid, $2::uuid, 'pending', 'Split Test Address', 28.45, 77.05, $3)
		RETURNING id::text`,
		customerID, serviceID, netPaise,
	).Scan(&bookingID); err != nil {
		t.Fatalf("insert pending booking: %v", err)
	}

	t.Cleanup(func() {
		ex := func(sql string, args ...any) { _, _ = pool.Exec(ctx, sql, args...) }
		ex(`DELETE FROM payments WHERE booking_id = $1::uuid`, bookingID)
		ex(`DELETE FROM wallet_transactions WHERE booking_id = $1::uuid`, bookingID)
		ex(`DELETE FROM wallet_transactions WHERE user_id = $1::uuid`, customerID)
		ex(`DELETE FROM bookings WHERE id = $1::uuid`, bookingID)
		ex(`DELETE FROM wallets WHERE user_id = $1::uuid`, customerID)
		ex(`DELETE FROM service_categories WHERE id = $1::uuid`, serviceID)
		ex(`DELETE FROM users WHERE id = $1::uuid`, customerID)
	})
	return bookingID
}

// newSplitTestService constructs a booking *Service wired with just the deps
// the split path needs: the wallet debiter adapter, the wallet repo (for the
// FOR UPDATE balance read), the payments ledger, and the pool. rdb/configSvc/
// matchEngine are left nil — payBookingSplit doesn't touch them.
func newSplitTestService(t *testing.T, pool *pgxpool.Pool, w *wallet.Service) *Service {
	t.Helper()
	svc := NewService(NewRepository(pool), pool, nil, nil, nil)
	svc.SetWallet(splitWalletAdapter{svc: w})
	svc.SetWalletRepo(wallet.NewRepository(pool))
	svc.SetPaymentsLedger(payments.NewLedger(pool))
	return svc
}

// payBookingSplit debits min(balance, net) and stamps wallet_applied_paise,
// leaving the booking unpaid (payment_status pending) for the Cashfree remainder.
func TestPayBookingSplit_PartialDebit(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()
	// seed: a booking row (pending) + a customer wallet with 3000 paise.
	customer := makeUUID(t, "split-cust")
	bookingID := seedPendingBooking(t, pool, customer, 13000 /*net*/)
	w := wallet.NewService(wallet.NewRepository(pool))
	if _, err := w.Credit(ctx, customer, 3000, wallet.KindAdjustment, nil, nil, "seed"); err != nil {
		t.Fatalf("seed wallet: %v", err)
	}
	svc := newSplitTestService(t, pool, w)

	applied, err := svc.payBookingSplit(ctx, bookingID, customer, 13000, 3000)
	if err != nil {
		t.Fatalf("payBookingSplit: %v", err)
	}
	if applied != 3000 {
		t.Fatalf("applied = %d, want 3000", applied)
	}
	// wallet drained to 0
	if bal, _ := wallet.NewRepository(pool).GetBalance(ctx, customer); bal != 0 {
		t.Fatalf("wallet balance = %d, want 0", bal)
	}
	// booking stamped: wallet_applied_paise=3000, payment_method='cashfree', payment_status pending (NULL)
	var applied2 int64
	var method, status *string
	if err := pool.QueryRow(ctx, `SELECT wallet_applied_paise, payment_method, payment_status FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&applied2, &method, &status); err != nil {
		t.Fatalf("read booking: %v", err)
	}
	if applied2 != 3000 || method == nil || *method != "cashfree" || status != nil {
		t.Fatalf("stamp mismatch: applied=%d method=%v status=%v", applied2, method, status)
	}
}

// When the wallet covers the whole net, payBookingSplit applies exactly net and
// drains the wallet by that much (the caller then treats it as fully paid).
func TestPayBookingSplit_FullCover(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()
	customer := makeUUID(t, "split-full")
	bookingID := seedPendingBooking(t, pool, customer, 5000 /*net*/)
	w := wallet.NewService(wallet.NewRepository(pool))
	if _, err := w.Credit(ctx, customer, 8000, wallet.KindAdjustment, nil, nil, "seed"); err != nil {
		t.Fatalf("seed wallet: %v", err)
	}
	svc := newSplitTestService(t, pool, w)

	// requestedApply 0 = no client cap; apply min(balance, net) = 5000.
	applied, err := svc.payBookingSplit(ctx, bookingID, customer, 5000, 0)
	if err != nil {
		t.Fatalf("payBookingSplit: %v", err)
	}
	if applied != 5000 {
		t.Fatalf("applied = %d, want 5000 (capped at net)", applied)
	}
	if bal, _ := wallet.NewRepository(pool).GetBalance(ctx, customer); bal != 3000 {
		t.Fatalf("wallet balance = %d, want 3000 (8000-5000)", bal)
	}
}

// An empty wallet applies 0 and leaves the booking untouched, so the caller
// falls back to the plain direct/Cashfree path.
func TestPayBookingSplit_EmptyWalletAppliesZero(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()
	customer := makeUUID(t, "split-empty")
	bookingID := seedPendingBooking(t, pool, customer, 9000 /*net*/)
	w := wallet.NewService(wallet.NewRepository(pool))
	svc := newSplitTestService(t, pool, w)

	applied, err := svc.payBookingSplit(ctx, bookingID, customer, 9000, 9000)
	if err != nil {
		t.Fatalf("payBookingSplit: %v", err)
	}
	if applied != 0 {
		t.Fatalf("applied = %d, want 0", applied)
	}
	var appliedCol int64
	var method *string
	if err := pool.QueryRow(ctx, `SELECT wallet_applied_paise, payment_method FROM bookings WHERE id=$1::uuid`, bookingID).
		Scan(&appliedCol, &method); err != nil {
		t.Fatalf("read booking: %v", err)
	}
	if appliedCol != 0 || method != nil {
		t.Fatalf("expected untouched booking: applied=%d method=%v", appliedCol, method)
	}
}

// Cancelling a split booking that never paid its Cashfree remainder must
// credit the wallet_applied_paise back to the customer and zero the column.
func TestSplitCancel_RefundsWalletPortion(t *testing.T) {
	pool := splitTestPool(t)
	ctx := context.Background()
	customer := makeUUID(t, "split-cancel")
	bookingID := seedPendingBooking(t, pool, customer, 13000)
	w := wallet.NewService(wallet.NewRepository(pool))
	if _, err := w.Credit(ctx, customer, 3000, wallet.KindAdjustment, nil, nil, "seed"); err != nil {
		t.Fatalf("seed wallet: %v", err)
	}
	svc := newSplitTestService(t, pool, w)
	if _, err := svc.payBookingSplit(ctx, bookingID, customer, 13000, 3000); err != nil {
		t.Fatalf("split: %v", err)
	}
	// balance now 0; cancel the unpaid split.
	if err := svc.refundSplitWalletOnCancel(ctx, bookingID); err != nil {
		t.Fatalf("refund on cancel: %v", err)
	}
	if bal, _ := wallet.NewRepository(pool).GetBalance(ctx, customer); bal != 3000 {
		t.Fatalf("balance after cancel-refund = %d, want 3000", bal)
	}
	// idempotent: a second cancel must not double-refund.
	if err := svc.refundSplitWalletOnCancel(ctx, bookingID); err != nil {
		t.Fatalf("refund on cancel (2nd): %v", err)
	}
	if bal, _ := wallet.NewRepository(pool).GetBalance(ctx, customer); bal != 3000 {
		t.Fatalf("balance after double cancel = %d, want 3000 (no double-refund)", bal)
	}
}
