package orders

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func openOrdersTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed orders tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

func ensureOrdersCustomer(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	phone := "test-ord-" + userID[len(userID)-8:]
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')
		ON CONFLICT (id) DO NOTHING
	`, userID, phone); err != nil {
		t.Fatalf("ensure customer: %v", err)
	}
}

// makeCancelledBooking inserts a cancelled booking with the given cancelled_by
// value for the fixture customer, tagged with locality for cleanup.
func makeCancelledBooking(t *testing.T, pool *pgxpool.Pool, customerID, locality, cancelledBy string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO bookings
		  (customer_id, status, address, lat, lng, amount_paise,
		   total_duration_minutes, locality, cancelled_at, cancelled_by)
		VALUES ($1::uuid, 'cancelled', 'Test Addr', 28.45, 77.05, 10000, 60, $2, now(), $3)
	`, customerID, locality, cancelledBy); err != nil {
		t.Fatalf("insert cancelled booking: %v", err)
	}
}

// TestList_CancelledByFilter verifies the cancelled_by filter returns only
// matching rows, that 'admin' catches both the bare and prefixed forms, and
// that an unrecognised value is ignored (returns all rows for the customer).
func TestList_CancelledByFilter(t *testing.T) {
	pool := openOrdersTestDB(t)
	repo := NewRepository(pool, pool)
	ctx := context.Background()

	const (
		customerID = "66660000-0000-0000-0000-000000000001"
		locality   = "orderstest-cancelledby"
	)
	ensureOrdersCustomer(t, pool, customerID)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM bookings WHERE locality = $1`, locality)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1::uuid`, customerID)
	})

	makeCancelledBooking(t, pool, customerID, locality, "no_pros_found")
	makeCancelledBooking(t, pool, customerID, locality, "customer")
	makeCancelledBooking(t, pool, customerID, locality, "admin")
	makeCancelledBooking(t, pool, customerID, locality, "admin:ops@zopmop.in")

	// Filtering by customer_id isolates this test's rows from the shared DB.
	list := func(cancelledBy string) (int, int) {
		t.Helper()
		items, total, err := repo.List(ctx, "", "", "", customerID, "", cancelledBy,
			nil, nil, nil, nil, "", "", 100, 0)
		if err != nil {
			t.Fatalf("List(cancelled_by=%q): %v", cancelledBy, err)
		}
		return len(items), total
	}

	// no_pros_found → exactly the one matching row (spec §5.5 feed).
	if n, total := list("no_pros_found"); n != 1 || total != 1 {
		t.Fatalf("no_pros_found filter: items=%d total=%d, want 1/1", n, total)
	}
	// customer → exactly one.
	if n, total := list("customer"); n != 1 || total != 1 {
		t.Fatalf("customer filter: items=%d total=%d, want 1/1", n, total)
	}
	// admin → both 'admin' and 'admin:<email>' (prefix match).
	if n, total := list("admin"); n != 2 || total != 2 {
		t.Fatalf("admin filter: items=%d total=%d, want 2/2", n, total)
	}
	// helper → none seeded for this customer.
	if n, total := list("helper"); n != 0 || total != 0 {
		t.Fatalf("helper filter: items=%d total=%d, want 0/0", n, total)
	}
	// Unrecognised value is ignored → all four rows returned.
	if n, total := list("bogus_value"); n != 4 || total != 4 {
		t.Fatalf("unrecognised filter: items=%d total=%d, want 4/4 (filter ignored)", n, total)
	}
	// Empty value → no filter → all four rows.
	if n, total := list(""); n != 4 || total != 4 {
		t.Fatalf("empty filter: items=%d total=%d, want 4/4", n, total)
	}
}
