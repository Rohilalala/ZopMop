package offers

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// openOffersTestDB connects to the test database, skipping when
// TEST_DATABASE_URL is unset (mirrors the wallet/notification test pattern).
func openOffersTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed offers tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect test db: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestListForUser_NewUsersAudience reproduces the GET /offers 500: listForUser's
// new_users branch referenced bookings.user_id, but the column is customer_id, so
// the query failed to parse for EVERY authenticated user. After the fix a user
// with no bookings must see the new_users promo without error.
func TestListForUser_NewUsersAudience(t *testing.T) {
	db := openOffersTestDB(t)
	ctx := context.Background()

	const code = "AUDITTEST_NEWUSER"
	_, _ = db.Exec(ctx, `DELETE FROM promotions WHERE code = $1`, code)
	if _, err := db.Exec(ctx, `
		INSERT INTO promotions (code, discount_type, discount_value, audience, is_active)
		VALUES ($1, 'percent', 10, 'new_users', true)`, code); err != nil {
		t.Fatalf("seed new_users promo: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(ctx, `DELETE FROM promotions WHERE code = $1`, code) })

	// A fresh user id with no bookings qualifies for the new_users audience.
	const freshUser = "00000000-0000-0000-0000-0000000000ff"

	offers, err := listForUser(ctx, db, freshUser)
	if err != nil {
		t.Fatalf("listForUser returned error (the user_id-vs-customer_id bug): %v", err)
	}
	found := false
	for _, o := range offers {
		if o.Code == code {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected new_users promo %q visible to a user with no bookings; got %d offers", code, len(offers))
	}
}

// A 'specific'-audience promo (targeted via audience_user_ids) must be visible
// to a targeted user. The handler queried audience='user_segment', a value the
// promotions.audience CHECK forbids, so targeted promos never showed.
func TestListForUser_SpecificAudience(t *testing.T) {
	db := openOffersTestDB(t)
	ctx := context.Background()

	const code = "AUDITTEST_TARGETED"
	const targetUser = "00000000-0000-0000-0000-0000000000a1"
	_, _ = db.Exec(ctx, `DELETE FROM promotions WHERE code = $1`, code)
	if _, err := db.Exec(ctx, `
		INSERT INTO promotions (code, discount_type, discount_value, audience, audience_user_ids, is_active)
		VALUES ($1, 'fixed', 5000, 'specific', ARRAY[$2::uuid], true)`, code, targetUser); err != nil {
		t.Fatalf("seed specific promo: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(ctx, `DELETE FROM promotions WHERE code = $1`, code) })

	offers, err := listForUser(ctx, db, targetUser)
	if err != nil {
		t.Fatalf("listForUser: %v", err)
	}
	found := false
	for _, o := range offers {
		if o.Code == code {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected targeted promo %q visible to the targeted user; got %d offers", code, len(offers))
	}
}
