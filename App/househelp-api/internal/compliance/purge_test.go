package compliance

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-backed integration tests for chunk 2. Skipped when TEST_DATABASE_URL
// is unset. Schema must include migrations up to 074 (tombstone row).

func openComplianceTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping compliance DB-backed tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect db: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// makeUser inserts a test user and returns its UUID. Phone is derived
// from the suffix to avoid users_phone_key collisions across parallel
// tests. Cleaned up by t.Cleanup.
func makeUser(t *testing.T, pool *pgxpool.Pool, suffix string) string {
	t.Helper()
	id := uuid.NewString()
	phone := "del:cmpl-" + suffix[:6]
	_, err := pool.Exec(context.Background(), `
		INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')
	`, id, phone)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		// Delete child rows we may have inserted; CASCADE handles most.
		_, _ = pool.Exec(context.Background(), `DELETE FROM booking_messages WHERE sender_id=$1::uuid`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1::uuid`, id)
	})
	return id
}

// makeBooking inserts a minimal bookings row so booking_messages can FK
// to it. Cleaned up by t.Cleanup.
func makeBooking(t *testing.T, pool *pgxpool.Pool, customerID string) string {
	t.Helper()
	id := uuid.NewString()
	// service_categories has a row created by some earlier migration; pick any.
	var serviceCategoryID string
	if err := pool.QueryRow(context.Background(),
		`SELECT id::text FROM service_categories LIMIT 1`).Scan(&serviceCategoryID); err != nil {
		t.Skipf("no service_categories row to FK to: %v", err)
	}
	// status='completed' bypasses the within-2-minutes dedup trigger
	// (fn_bookings_reject_dup_within_hour fires on pending only). Tests
	// frequently insert multiple bookings per customer in quick
	// succession — completed semantics fit (reviews require completed
	// bookings anyway).
	_, err := pool.Exec(context.Background(), `
		INSERT INTO bookings (id, customer_id, service_category_id, address, lat, lng, amount_paise, status)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'test addr', 12.9, 77.6, 1000, 'completed')
	`, id, customerID, serviceCategoryID)
	if err != nil {
		t.Fatalf("insert booking: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM bookings WHERE id=$1::uuid`, id)
	})
	return id
}

func TestAnonymizeBookingMessages_ReassignsSender(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())

	userA := makeUser(t, pool, uuid.NewString())
	userB := makeUser(t, pool, uuid.NewString())
	bookingID := makeBooking(t, pool, userA)

	// Insert two messages from A and one from B against the same booking.
	for _, sender := range []string{userA, userA, userB} {
		_, err := pool.Exec(context.Background(), `
			INSERT INTO booking_messages (booking_id, sender_id, sender_role, body)
			VALUES ($1::uuid, $2::uuid, 'customer', 'hello')
		`, bookingID, sender)
		if err != nil {
			t.Fatalf("seed booking_message: %v", err)
		}
	}

	got, err := svc.AnonymizeBookingMessages(context.Background(), userA)
	if err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	if got != 2 {
		t.Fatalf("rows reassigned = %d, want 2", got)
	}

	// User A's messages now point at the tombstone; user B's untouched.
	var aRemaining, bRemaining, tombstoneRows int
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM booking_messages WHERE sender_id=$1::uuid`, userA).Scan(&aRemaining); err != nil {
		t.Fatalf("count A: %v", err)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM booking_messages WHERE sender_id=$1::uuid`, userB).Scan(&bRemaining); err != nil {
		t.Fatalf("count B: %v", err)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM booking_messages WHERE sender_id=$1::uuid AND booking_id=$2::uuid`,
		TombstoneUserID, bookingID).Scan(&tombstoneRows); err != nil {
		t.Fatalf("count tombstone: %v", err)
	}

	if aRemaining != 0 {
		t.Fatalf("user A still has %d messages; expected 0", aRemaining)
	}
	if bRemaining != 1 {
		t.Fatalf("user B has %d messages; expected 1 (untouched)", bRemaining)
	}
	if tombstoneRows != 2 {
		t.Fatalf("tombstone has %d messages for booking; expected 2", tombstoneRows)
	}
}

func TestPurgeTrivialUserData_DeletesAllTables(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())

	userID := makeUser(t, pool, uuid.NewString())
	otherID := makeUser(t, pool, uuid.NewString())
	ctx := context.Background()

	// Seed every trivial table for userID. Plus one row for otherID per
	// table to confirm the purge is scoped (doesn't sweep other users).
	mustExec(t, pool, `
		INSERT INTO user_addresses (user_id, tag, title, flat_no, building_name, full_address, lat, lon)
		VALUES ($1::uuid, 'Home', 't', '1', 'b', 'addr', 12.9, 77.6),
		       ($2::uuid, 'Home', 't', '1', 'b', 'addr', 12.9, 77.6)
	`, userID, otherID)
	mustExec(t, pool, `
		INSERT INTO device_tokens (user_id, fcm_token, platform, device_id)
		VALUES ($1::uuid, 'tok-a', 'ios', 'dev-a'),
		       ($2::uuid, 'tok-b', 'ios', 'dev-b')
	`, userID, otherID)
	mustExec(t, pool, `
		INSERT INTO device_tokens (worker_id, fcm_token, platform, device_id)
		VALUES ($1::uuid, 'tok-w', 'ios', 'dev-w')
	`, userID)
	mustExec(t, pool, `INSERT INTO cart (user_id) VALUES ($1::uuid), ($2::uuid)`, userID, otherID)
	mustExec(t, pool, `
		INSERT INTO user_preferred_helpers (user_id, helper_id) VALUES
		($1::uuid, $2::uuid),
		($2::uuid, $1::uuid)
	`, userID, otherID)
	mustExec(t, pool, `
		INSERT INTO reengagement_notifications (user_id, scenario, window_start)
		VALUES ($1::uuid, 'test', now()),
		       ($2::uuid, 'test', now())
	`, userID, otherID)

	report, err := svc.PurgeTrivialUserData(ctx, userID)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}

	// Spot-check the report numbers.
	if report.UserAddresses != 1 {
		t.Errorf("UserAddresses = %d, want 1", report.UserAddresses)
	}
	if report.DeviceTokensAsUser != 1 {
		t.Errorf("DeviceTokensAsUser = %d, want 1", report.DeviceTokensAsUser)
	}
	if report.DeviceTokensAsWorker != 1 {
		t.Errorf("DeviceTokensAsWorker = %d, want 1", report.DeviceTokensAsWorker)
	}
	if report.Cart != 1 {
		t.Errorf("Cart = %d, want 1", report.Cart)
	}
	// Bilateral on user_preferred_helpers — userID appears as both user_id and helper_id.
	if report.UserPreferredHelpersAsUser != 1 {
		t.Errorf("UserPreferredHelpersAsUser = %d, want 1", report.UserPreferredHelpersAsUser)
	}
	if report.UserPreferredHelpersAsHelper != 1 {
		t.Errorf("UserPreferredHelpersAsHelper = %d, want 1", report.UserPreferredHelpersAsHelper)
	}
	if report.ReengagementNotifications != 1 {
		t.Errorf("ReengagementNotifications = %d, want 1", report.ReengagementNotifications)
	}

	// Confirm scope: otherID's rows untouched.
	for _, tbl := range []string{
		"user_addresses", "cart", "reengagement_notifications",
	} {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM `+tbl+` WHERE user_id=$1::uuid`, otherID).Scan(&n); err != nil {
			t.Fatalf("scope-check %s: %v", tbl, err)
		}
		if n == 0 {
			t.Fatalf("scope-check %s: other user's row was incorrectly purged", tbl)
		}
	}

	// Cleanup the other-user rows we inserted (they outlive makeUser's
	// cleanup since they don't reference the t.Cleanup-scoped row IDs).
	mustExec(t, pool, `DELETE FROM user_addresses WHERE user_id=$1::uuid`, otherID)
	mustExec(t, pool, `DELETE FROM device_tokens WHERE user_id=$1::uuid OR worker_id=$1::uuid`, otherID)
	mustExec(t, pool, `DELETE FROM cart WHERE user_id=$1::uuid`, otherID)
	mustExec(t, pool, `DELETE FROM reengagement_notifications WHERE user_id=$1::uuid`, otherID)
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec %q: %v", truncateForLog(sql, 60), err)
	}
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// makeReview inserts a review tying a customer to a helper for a given
// booking and returns the new review id. Cleaned up by t.Cleanup.
func makeReview(t *testing.T, pool *pgxpool.Pool, bookingID, customerID, helperID string, rating int) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO reviews (booking_id, customer_id, helper_id, rating, comment)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'great work')
		RETURNING id::text
	`, bookingID, customerID, helperID, rating).Scan(&id)
	if err != nil {
		t.Fatalf("insert review: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM reviews WHERE id=$1::uuid`, id)
	})
	return id
}

// makeHelper ensures a helpers row exists for the given user (helpers.id
// 1:1 with users.id). Returns the same id. Cleaned up by t.Cleanup.
func makeHelper(t *testing.T, pool *pgxpool.Pool, userID string) string {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO helpers (id) VALUES ($1::uuid) ON CONFLICT (id) DO NOTHING
	`, userID)
	if err != nil {
		t.Fatalf("insert helper: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM helpers WHERE id=$1::uuid`, userID)
	})
	return userID
}

func TestAnonymizeReviewsAsCustomer_ReassignsCustomerID(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())

	customerA := makeUser(t, pool, uuid.NewString())
	customerB := makeUser(t, pool, uuid.NewString())
	helperUser := makeUser(t, pool, uuid.NewString())
	helperID := makeHelper(t, pool, helperUser)

	bookingA := makeBooking(t, pool, customerA)
	bookingB := makeBooking(t, pool, customerB)
	makeReview(t, pool, bookingA, customerA, helperID, 5)
	makeReview(t, pool, bookingB, customerB, helperID, 4)

	got, err := svc.AnonymizeReviewsAsCustomer(context.Background(), customerA)
	if err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	if got != 1 {
		t.Fatalf("rows reassigned = %d, want 1", got)
	}

	var aRem, bRem, tomb int
	pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM reviews WHERE customer_id=$1::uuid`, customerA).Scan(&aRem)
	pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM reviews WHERE customer_id=$1::uuid`, customerB).Scan(&bRem)
	pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM reviews WHERE customer_id=$1::uuid AND helper_id=$2::uuid`, TombstoneUserID, helperID).Scan(&tomb)

	if aRem != 0 {
		t.Fatalf("customer A still has %d reviews", aRem)
	}
	if bRem != 1 {
		t.Fatalf("customer B has %d reviews; expected untouched (1)", bRem)
	}
	if tomb != 1 {
		t.Fatalf("tombstone has %d reviews against helper; expected 1", tomb)
	}
}

func TestAnonymizeReviewsAsHelper_ReassignsHelperID(t *testing.T) {
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())

	customer := makeUser(t, pool, uuid.NewString())
	helperUserA := makeUser(t, pool, uuid.NewString())
	helperUserB := makeUser(t, pool, uuid.NewString())
	helperA := makeHelper(t, pool, helperUserA)
	helperB := makeHelper(t, pool, helperUserB)

	bookingA := makeBooking(t, pool, customer)
	bookingB := makeBooking(t, pool, customer)
	makeReview(t, pool, bookingA, customer, helperA, 5)
	makeReview(t, pool, bookingB, customer, helperB, 4)

	got, err := svc.AnonymizeReviewsAsHelper(context.Background(), helperA)
	if err != nil {
		t.Fatalf("anonymize: %v", err)
	}
	if got != 1 {
		t.Fatalf("rows reassigned = %d, want 1", got)
	}

	var aRem, bRem, tomb int
	pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM reviews WHERE helper_id=$1::uuid`, helperA).Scan(&aRem)
	pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM reviews WHERE helper_id=$1::uuid`, helperB).Scan(&bRem)
	pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM reviews WHERE helper_id=$1::uuid AND customer_id=$2::uuid`, TombstoneUserID, customer).Scan(&tomb)

	if aRem != 0 {
		t.Fatalf("helper A still has %d reviews", aRem)
	}
	if bRem != 1 {
		t.Fatalf("helper B has %d reviews; expected untouched (1)", bRem)
	}
	if tomb != 1 {
		t.Fatalf("tombstone helper has %d reviews; expected 1", tomb)
	}
}

func TestAnonymizeReviewsAsCustomer_RatingUnchanged(t *testing.T) {
	// Trigger fn_reviews_recompute_helper_rating fires only on UPDATE OF
	// rating; touching customer_id alone must not move helpers.rating.
	pool := openComplianceTestDB(t)
	svc := NewService(pool, NewRegistry())

	customer := makeUser(t, pool, uuid.NewString())
	helperUser := makeUser(t, pool, uuid.NewString())
	helperID := makeHelper(t, pool, helperUser)

	bookingID := makeBooking(t, pool, customer)
	makeReview(t, pool, bookingID, customer, helperID, 4) // triggers initial recompute → 4.00

	var beforeRating float64
	if err := pool.QueryRow(context.Background(),
		`SELECT rating FROM helpers WHERE id=$1::uuid`, helperID).Scan(&beforeRating); err != nil {
		t.Fatalf("read rating before: %v", err)
	}

	if _, err := svc.AnonymizeReviewsAsCustomer(context.Background(), customer); err != nil {
		t.Fatalf("anonymize: %v", err)
	}

	var afterRating float64
	if err := pool.QueryRow(context.Background(),
		`SELECT rating FROM helpers WHERE id=$1::uuid`, helperID).Scan(&afterRating); err != nil {
		t.Fatalf("read rating after: %v", err)
	}
	if beforeRating != afterRating {
		t.Fatalf("rating moved on customer-only anonymise: before=%v after=%v", beforeRating, afterRating)
	}
}

// Compile-time guard so the file refers to the time import even in
// reduced builds.
var _ = time.Second
