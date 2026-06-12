package dashboard

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// openDashboardTestDB returns a pool against TEST_DATABASE_URL or skips.
func openDashboardTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed dashboard tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// ensureDashCustomer inserts a customer row keyed by the given UUID.
func ensureDashCustomer(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	phone := "test-dash-" + userID[len(userID)-8:]
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')
		ON CONFLICT (id) DO NOTHING
	`, userID, phone); err != nil {
		t.Fatalf("ensure customer: %v", err)
	}
}

// makeDashBooking inserts one booking with the given status, helper assignment,
// and scheduled_time, all tagged with locality so cleanup is isolated.
func makeDashBooking(t *testing.T, pool *pgxpool.Pool, customerID, locality, status string, helperID *string, scheduledAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO bookings
		  (customer_id, helper_id, status, address, lat, lng, amount_paise,
		   total_duration_minutes, scheduled_time, locality)
		VALUES ($1::uuid, $2::uuid, $3, 'Test Addr', 28.45, 77.05, 10000, 60, $4, $5)
	`, customerID, helperID, status, scheduledAt, locality); err != nil {
		t.Fatalf("insert booking: %v", err)
	}
}

// TestKPIs_BookingsAtRisk verifies the at-risk metric counts only in-window
// unassigned pending bookings (spec §14.1). dispatch.lead_min is absent from
// the test DB's app_config, so the metric uses the default 30-minute lead.
func TestKPIs_BookingsAtRisk(t *testing.T) {
	pool := openDashboardTestDB(t)
	svc := NewService(pool)
	ctx := context.Background()

	const (
		customerID = "55550000-0000-0000-0000-000000000001"
		helperID   = "55550000-0000-0000-0000-000000000002"
		locality   = "dashtest-at-risk-locality"
	)
	ensureDashCustomer(t, pool, customerID)
	ensureDashCustomer(t, pool, helperID) // helper rows live in users too
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM bookings WHERE locality = $1`, locality)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id IN ($1::uuid, $2::uuid)`, customerID, helperID)
	})

	// Baseline before our inserts — the shared test DB may hold other rows.
	base, err := svc.KPIs(ctx)
	if err != nil {
		t.Fatalf("baseline KPIs: %v", err)
	}

	now := time.Now()
	hid := helperID

	// (a) Future-far pending unassigned: scheduled 2h out — window (T−30m)
	//     hasn't opened, so now < scheduled−30m → NOT at risk.
	makeDashBooking(t, pool, customerID, locality, "pending", nil, now.Add(2*time.Hour))
	// (b) In-window pending unassigned: scheduled 10m out — now ≥ scheduled−30m
	//     → AT RISK.
	makeDashBooking(t, pool, customerID, locality, "pending", nil, now.Add(10*time.Minute))
	// (c) In-window pending unassigned, already past scheduled_time → AT RISK.
	makeDashBooking(t, pool, customerID, locality, "pending", nil, now.Add(-5*time.Minute))
	// (d) In-window but ASSIGNED (helper_id set) → NOT at risk.
	makeDashBooking(t, pool, customerID, locality, "pending", &hid, now.Add(10*time.Minute))
	// (e) In-window but not pending (accepted) → NOT at risk.
	makeDashBooking(t, pool, customerID, locality, "accepted", &hid, now.Add(10*time.Minute))

	got, err := svc.KPIs(ctx)
	if err != nil {
		t.Fatalf("KPIs: %v", err)
	}
	delta := got.BookingsAtRisk - base.BookingsAtRisk
	if delta != 2 {
		t.Fatalf("bookings_at_risk delta = %d, want 2 (only the two in-window unassigned pending rows)", delta)
	}
}

// TestKPIs_BookingsAtRisk_ConfigLead verifies a seeded dispatch.lead_min widens
// the at-risk window: a booking outside the default-30m window but inside a
// seeded-90m window is counted.
func TestKPIs_BookingsAtRisk_ConfigLead(t *testing.T) {
	pool := openDashboardTestDB(t)
	svc := NewService(pool)
	ctx := context.Background()

	const (
		customerID = "55551111-0000-0000-0000-000000000001"
		locality   = "dashtest-at-risk-config"
	)
	ensureDashCustomer(t, pool, customerID)

	// Seed a 90-minute lead; restore the absent row on cleanup.
	if _, err := pool.Exec(ctx, `
		INSERT INTO app_config (key, value, value_type)
		VALUES ('dispatch.lead_min', '90', 'int')
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
	`); err != nil {
		t.Fatalf("seed dispatch.lead_min: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM app_config WHERE key = 'dispatch.lead_min'`)
		_, _ = pool.Exec(ctx, `DELETE FROM bookings WHERE locality = $1`, locality)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1::uuid`, customerID)
	})

	base, err := svc.KPIs(ctx)
	if err != nil {
		t.Fatalf("baseline KPIs: %v", err)
	}

	now := time.Now()
	// Scheduled 60m out: outside the default 30m window, inside the seeded 90m
	// window (now ≥ scheduled−90m) → AT RISK only because of the config lead.
	makeDashBooking(t, pool, customerID, locality, "pending", nil, now.Add(60*time.Minute))

	got, err := svc.KPIs(ctx)
	if err != nil {
		t.Fatalf("KPIs: %v", err)
	}
	if delta := got.BookingsAtRisk - base.BookingsAtRisk; delta != 1 {
		t.Fatalf("bookings_at_risk delta = %d, want 1 (seeded 90m lead widens the window)", delta)
	}
}
