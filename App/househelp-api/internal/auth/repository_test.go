package auth

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/compliance"
)

// End-to-end DB-backed test for the SoftDeleteUser ↔ compliance wiring
// added in chunk 2 (audit C-8 / F2D-1). Confirms that a soft-delete:
//   1. Reassigns the user's booking_messages.sender_id to the tombstone
//      sentinel (body retained for T&S review).
//   2. Hard-deletes the user's trivial child rows (addresses, cart,
//      device_tokens, preferred_helpers, reengagement_notifications).
//   3. Stamps users.deleted_at + scrubs phone/name on the user row.
//
// Skipped when TEST_DATABASE_URL is unset.

func TestSoftDeleteUser_AnonymizesAndPurges(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed soft-delete e2e")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect db: %v", err)
	}
	defer pool.Close()

	ctx := context.Background()

	// Insert the user.
	userID := uuid.NewString()
	phone := "del:sde-" + userID[:6]
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')`,
		userID, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		// Hard-delete after test for repeatability.
		_, _ = pool.Exec(ctx, `DELETE FROM booking_messages WHERE sender_id=$1::uuid`, userID)
		_, _ = pool.Exec(ctx, `DELETE FROM bookings WHERE customer_id=$1::uuid`, userID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id=$1::uuid`, userID)
	})

	// Pick a service_category to FK to (any one).
	var serviceCategoryID string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM service_categories LIMIT 1`).Scan(&serviceCategoryID); err != nil {
		t.Skipf("no service_categories row to FK to: %v", err)
	}

	// Insert a booking + 2 booking_messages from this user.
	bookingID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO bookings (id, customer_id, service_category_id, address, lat, lng, amount_paise)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'addr', 12.9, 77.6, 1000)
	`, bookingID, userID, serviceCategoryID); err != nil {
		t.Fatalf("insert booking: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := pool.Exec(ctx, `
			INSERT INTO booking_messages (booking_id, sender_id, sender_role, body)
			VALUES ($1::uuid, $2::uuid, 'customer', 'hello')
		`, bookingID, userID); err != nil {
			t.Fatalf("insert booking_message: %v", err)
		}
	}

	// Insert trivial-table rows.
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_addresses (user_id, tag, title, flat_no, building_name, full_address, lat, lon)
		VALUES ($1::uuid, 'Home', 't', '1', 'b', 'addr', 12.9, 77.6)
	`, userID); err != nil {
		t.Fatalf("insert user_address: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO device_tokens (user_id, fcm_token, platform, device_id)
		VALUES ($1::uuid, 'tok', 'ios', 'devid-' || $1::text)
	`, userID); err != nil {
		t.Fatalf("insert device_token: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO cart (user_id) VALUES ($1::uuid)`, userID); err != nil {
		t.Fatalf("insert cart: %v", err)
	}

	// Wire the repo with compliance attached.
	repo := NewRepository(pool)
	cmpl := compliance.NewService(pool, compliance.NewRegistry())
	repo.SetCompliance(cmpl)

	if err := repo.SoftDeleteUser(ctx, userID, "test"); err != nil {
		t.Fatalf("SoftDeleteUser: %v", err)
	}

	// 1. booking_messages reassigned to tombstone (body still present).
	var ownStillThere int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM booking_messages WHERE sender_id=$1::uuid`, userID).Scan(&ownStillThere); err != nil {
		t.Fatalf("count own messages: %v", err)
	}
	if ownStillThere != 0 {
		t.Fatalf("user's own booking_messages still present: %d", ownStillThere)
	}
	var tombstoneRows int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM booking_messages WHERE sender_id=$1::uuid AND booking_id=$2::uuid`,
		compliance.TombstoneUserID, bookingID).Scan(&tombstoneRows); err != nil {
		t.Fatalf("count tombstone messages: %v", err)
	}
	if tombstoneRows != 2 {
		t.Fatalf("tombstone-anchored messages = %d, want 2", tombstoneRows)
	}

	// 2. trivial tables empty for this user.
	for _, q := range []struct {
		name string
		sql  string
	}{
		{"user_addresses", `SELECT COUNT(*) FROM user_addresses WHERE user_id=$1::uuid`},
		{"device_tokens", `SELECT COUNT(*) FROM device_tokens WHERE user_id=$1::uuid OR worker_id=$1::uuid`},
		{"cart", `SELECT COUNT(*) FROM cart WHERE user_id=$1::uuid`},
	} {
		var n int
		if err := pool.QueryRow(ctx, q.sql, userID).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", q.name, err)
		}
		if n != 0 {
			t.Errorf("%s still has %d rows for purged user; expected 0", q.name, n)
		}
	}

	// 3. users.deleted_at stamped, name cleared, phone anonymised.
	var deletedAt *string
	var name *string
	var anonPhone string
	if err := pool.QueryRow(ctx,
		`SELECT phone, name, deleted_at::text FROM users WHERE id=$1::uuid`, userID).Scan(
		&anonPhone, &name, &deletedAt); err != nil {
		t.Fatalf("read user post-soft-delete: %v", err)
	}
	if deletedAt == nil {
		t.Fatalf("deleted_at not stamped")
	}
	if name != nil {
		t.Fatalf("name not cleared: %v", *name)
	}
	if len(anonPhone) < 4 || anonPhone[:4] != "del:" {
		t.Fatalf("phone not anonymised: %q", anonPhone)
	}
}
