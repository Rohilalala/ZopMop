package booking

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestBookingHelperIDPointsToHelperRow documents the loose-typing concern
// from audit B5-D5: bookings.helper_id is FK to users(id), but
// reviews.helper_id is FK to helpers(id). The schema permits a booking to
// reference a customer-role user that has no helpers row.
//
// This test asserts the invariant directly: every booking with a non-null
// helper_id must have a matching helpers row. If this ever fails in
// production, a customer was assigned to a booking — investigate.
//
// Skipped when TEST_DATABASE_URL is unset (no DB available in unit-test
// runs); CI integration job points it at a real Postgres.
func TestBookingHelperIDPointsToHelperRow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}

	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	var orphanCount int
	err = pool.QueryRow(context.Background(), `
		SELECT COUNT(*)
		FROM bookings b
		WHERE b.helper_id IS NOT NULL
		  AND NOT EXISTS (
		      SELECT 1 FROM helpers h WHERE h.id = b.helper_id
		  )
	`).Scan(&orphanCount)
	if err != nil {
		t.Fatalf("query: %v", err)
	}

	if orphanCount > 0 {
		t.Errorf("found %d bookings with helper_id pointing to non-helper user (audit B5-D5)", orphanCount)
	}
}
