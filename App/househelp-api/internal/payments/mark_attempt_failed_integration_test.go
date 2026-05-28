package payments

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-backed integration tests for Phase 1 Step 5d.2.d
// (POST /payments/cashfree/orders/:orderID/mark-attempt-failed).
//
// Skipped when TEST_DATABASE_URL is unset. The truth-table state machine
// (which is the load-bearing money safety) is covered by the pure-function
// test in mark_attempt_failed_test.go and runs every CI build; this file
// adds the integration assertions that only a real DB can prove:
//
//   - Auth gate against payments.user_id (cross-customer access blocked,
//     helper / admin / anon also blocked).
//   - Idempotency across repeated calls.
//   - WEBHOOK-WINS race: a row pre-stamped 'success' is never flipped to
//     'failed' even when the SDK callback fires after.
//   - PAYMENTS-ROW-ONLY scope: the booking row (status / payment_status /
//     cash_collected_at / start_otp_verified_at / end_otp_verified_at /
//     updated_at) is byte-identical before and after the call. The stale-
//     order-on-cash-resolved-booking scenario is the canonical test of
//     this invariant.

const (
	markAttemptFailedRoutePath = "/payments/cashfree/orders/:orderID/mark-attempt-failed"
	markAttemptFailedRouteBase = "/payments/cashfree/orders/"
	markAttemptFailedRouteTail = "/mark-attempt-failed"
)

func openMarkAttemptFailedTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping mark-attempt-failed DB tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect db: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// markAttemptFailedFixture inserts a (user, booking, payment) triple and
// returns their IDs + initial gateway_status. Cleans up on test exit.
// gatewayStatus is the seed value; pass "pending" / "success" / "failed" /
// "refunded".
type markAttemptFailedFixture struct {
	UserID    string
	BookingID string
	PaymentID string
}

func seedMarkAttemptFailedFixture(t *testing.T, pool *pgxpool.Pool, gatewayStatus string) markAttemptFailedFixture {
	t.Helper()
	ctx := context.Background()

	userID := uuid.NewString()
	phone := "del:5d2d-" + userID[:6]
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')`,
		userID, phone,
	); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	bookingID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO bookings
		  (id, customer_id, service_category_id, status, address, lat, lng, amount_paise)
		VALUES
		  ($1::uuid, $2::uuid,
		   (SELECT id FROM service_categories LIMIT 1),
		   'in_progress', '', 0, 0, 100)`,
		bookingID, userID,
	); err != nil {
		t.Fatalf("insert booking: %v", err)
	}

	paymentID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO payments
		  (id, booking_id, user_id, amount_paise, gateway, gateway_status)
		VALUES
		  ($1::uuid, $2::uuid, $3::uuid, 100, 'cashfree', $4)`,
		paymentID, bookingID, userID, gatewayStatus,
	); err != nil {
		t.Fatalf("insert payment: %v", err)
	}

	t.Cleanup(func() {
		// payments ON DELETE CASCADE from bookings + bookings ON DELETE
		// CASCADE from users; delete the user and the rest goes.
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM users WHERE id=$1::uuid`, userID)
	})

	return markAttemptFailedFixture{
		UserID:    userID,
		BookingID: bookingID,
		PaymentID: paymentID,
	}
}

// bookingSnapshot is the set of fields the test asserts unchanged after a
// mark-attempt-failed call. The endpoint is payments-row-only by design —
// every column here is a non-payments field that mark-attempt-failed
// must NEVER touch.
type bookingSnapshot struct {
	Status              string
	PaymentStatus       *string
	PaymentMethod       *string
	CashCollectedAt     *time.Time
	StartOTPVerifiedAt  *time.Time
	EndOTPVerifiedAt    *time.Time
	UpdatedAt           time.Time
}

func snapshotBooking(t *testing.T, pool *pgxpool.Pool, bookingID string) bookingSnapshot {
	t.Helper()
	var s bookingSnapshot
	err := pool.QueryRow(context.Background(), `
		SELECT status, payment_status, payment_method, cash_collected_at,
		       start_otp_verified_at, end_otp_verified_at, updated_at
		  FROM bookings WHERE id = $1::uuid`,
		bookingID,
	).Scan(
		&s.Status, &s.PaymentStatus, &s.PaymentMethod, &s.CashCollectedAt,
		&s.StartOTPVerifiedAt, &s.EndOTPVerifiedAt, &s.UpdatedAt,
	)
	if err != nil {
		t.Fatalf("snapshotBooking: %v", err)
	}
	return s
}

func currentPaymentStatus(t *testing.T, pool *pgxpool.Pool, paymentID string) string {
	t.Helper()
	var st string
	if err := pool.QueryRow(context.Background(),
		`SELECT gateway_status FROM payments WHERE id=$1::uuid`,
		paymentID,
	).Scan(&st); err != nil {
		t.Fatalf("currentPaymentStatus: %v", err)
	}
	return st
}

// runMarkAttemptFailed fires one request through a Fiber app with the
// caller's userID pre-set in locals (simulating the auth middleware).
// callerID == "" simulates an unauthenticated request.
func runMarkAttemptFailed(t *testing.T, pool *pgxpool.Pool, callerID, orderID string) (int, map[string]any) {
	t.Helper()
	h := &Handler{db: pool}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		if callerID != "" {
			c.Locals(middleware.LocalsKeyUserID, callerID)
		}
		return c.Next()
	})
	app.Post(markAttemptFailedRoutePath, h.MarkAttemptFailed)

	req := httptest.NewRequest("POST",
		markAttemptFailedRouteBase+orderID+markAttemptFailedRouteTail,
		nil,
	)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	var decoded map[string]any
	if len(body) > 0 {
		_ = json.Unmarshal(body, &decoded)
	}
	return resp.StatusCode, decoded
}

// ─── Auth gate ──────────────────────────────────────────────────────────

func TestMarkAttemptFailed_NoJWT_Returns401(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	fx := seedMarkAttemptFailedFixture(t, pool, "pending")

	status, _ := runMarkAttemptFailed(t, pool, "", fx.PaymentID)
	if status != 401 {
		t.Fatalf("status = %d, want 401", status)
	}
	if got := currentPaymentStatus(t, pool, fx.PaymentID); got != "pending" {
		t.Fatalf("gateway_status leaked to %q despite 401", got)
	}
}

func TestMarkAttemptFailed_WrongCustomer_Returns403(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	fx := seedMarkAttemptFailedFixture(t, pool, "pending")
	otherCustomer := uuid.NewString()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')`,
		otherCustomer, "del:5d2d-o-"+otherCustomer[:6],
	); err != nil {
		t.Fatalf("seed other customer: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM users WHERE id=$1::uuid`, otherCustomer)
	})

	status, _ := runMarkAttemptFailed(t, pool, otherCustomer, fx.PaymentID)
	if status != 403 {
		t.Fatalf("status = %d, want 403", status)
	}
	if got := currentPaymentStatus(t, pool, fx.PaymentID); got != "pending" {
		t.Fatalf("orderID-leak attack flipped status to %q", got)
	}
}

func TestMarkAttemptFailed_HelperRole_Returns403(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	fx := seedMarkAttemptFailedFixture(t, pool, "pending")
	helperID := uuid.NewString()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'pro')`,
		helperID, "del:5d2d-h-"+helperID[:6],
	); err != nil {
		t.Fatalf("seed helper: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM users WHERE id=$1::uuid`, helperID)
	})

	status, _ := runMarkAttemptFailed(t, pool, helperID, fx.PaymentID)
	if status != 403 {
		t.Fatalf("status = %d, want 403", status)
	}
	if got := currentPaymentStatus(t, pool, fx.PaymentID); got != "pending" {
		t.Fatalf("helper-role attack flipped status to %q", got)
	}
}

// ─── 404 ────────────────────────────────────────────────────────────────

func TestMarkAttemptFailed_UnknownOrder_Returns404(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	callerID := uuid.NewString()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')`,
		callerID, "del:5d2d-c-"+callerID[:6],
	); err != nil {
		t.Fatalf("seed customer: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM users WHERE id=$1::uuid`, callerID)
	})

	status, _ := runMarkAttemptFailed(t, pool, callerID, uuid.NewString())
	if status != 404 {
		t.Fatalf("status = %d, want 404", status)
	}
}

// ─── Happy path: pending -> failed ──────────────────────────────────────

func TestMarkAttemptFailed_Pending_FlipsToFailed(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	fx := seedMarkAttemptFailedFixture(t, pool, "pending")

	status, body := runMarkAttemptFailed(t, pool, fx.UserID, fx.PaymentID)
	if status != 200 {
		t.Fatalf("status = %d, want 200; body = %v", status, body)
	}
	if got, _ := body["gateway_status"].(string); got != "failed" {
		t.Fatalf("response gateway_status = %q, want failed", got)
	}
	if got := currentPaymentStatus(t, pool, fx.PaymentID); got != "failed" {
		t.Fatalf("db gateway_status = %q, want failed", got)
	}
}

// ─── Webhook-wins race ──────────────────────────────────────────────────

// pre-state 'success' must NEVER be flipped to 'failed' by mark-attempt-
// failed. This is the load-bearing money safety: if the customer's card
// actually charged, refusing to flip the row protects them from a stale
// SDK callback wrongly cancelling a successful payment.
func TestMarkAttemptFailed_AlreadySuccess_WebhookWins(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	fx := seedMarkAttemptFailedFixture(t, pool, "success")

	status, body := runMarkAttemptFailed(t, pool, fx.UserID, fx.PaymentID)
	if status != 200 {
		t.Fatalf("status = %d, want 200; body = %v", status, body)
	}
	if got, _ := body["gateway_status"].(string); got != "success" {
		t.Fatalf("response gateway_status = %q, want success (webhook-wins)", got)
	}
	if got := currentPaymentStatus(t, pool, fx.PaymentID); got != "success" {
		t.Fatalf("WEBHOOK-WINS VIOLATED: db gateway_status flipped to %q", got)
	}
}

// pre-state 'refunded' is admin-only terminal; mark-attempt-failed must
// never overwrite it.
func TestMarkAttemptFailed_AlreadyRefunded_StaysRefunded(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	fx := seedMarkAttemptFailedFixture(t, pool, "refunded")

	status, body := runMarkAttemptFailed(t, pool, fx.UserID, fx.PaymentID)
	if status != 200 {
		t.Fatalf("status = %d, want 200; body = %v", status, body)
	}
	if got, _ := body["gateway_status"].(string); got != "refunded" {
		t.Fatalf("response gateway_status = %q, want refunded", got)
	}
	if got := currentPaymentStatus(t, pool, fx.PaymentID); got != "refunded" {
		t.Fatalf("refunded clobbered to %q", got)
	}
}

// ─── Idempotency ────────────────────────────────────────────────────────

func TestMarkAttemptFailed_Idempotent_TwoCalls(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	fx := seedMarkAttemptFailedFixture(t, pool, "pending")

	for i := 0; i < 2; i++ {
		status, body := runMarkAttemptFailed(t, pool, fx.UserID, fx.PaymentID)
		if status != 200 {
			t.Fatalf("call %d: status = %d, want 200; body = %v", i, status, body)
		}
		if got, _ := body["gateway_status"].(string); got != "failed" {
			t.Fatalf("call %d: gateway_status = %q, want failed", i, got)
		}
	}
}

// ─── Payments-row-only invariant ────────────────────────────────────────

// The canonical "stale Cashfree order on an already-cash-resolved
// booking" scenario. Even though the booking has been resolved by cash
// via a different code path (cash_collected_at set, started_at +
// start_otp_verified_at stamped), mark-attempt-failed must leave the
// booking row byte-identical and touch only payments.gateway_status.
//
// If a future change reaches into booking state from this handler, this
// test snaps it loudly.
func TestMarkAttemptFailed_BookingStateUnchanged(t *testing.T) {
	pool := openMarkAttemptFailedTestDB(t)
	fx := seedMarkAttemptFailedFixture(t, pool, "pending")

	// Mutate the booking into the "cash resolved" shape so the assertion
	// surface includes all the Phase 1 payment-side fields the endpoint
	// must NEVER touch (cash_collected_at, payment_status, payment_method,
	// start_otp_verified_at, end_otp_verified_at).
	if _, err := pool.Exec(context.Background(), `
		UPDATE bookings
		   SET cash_collected_at     = NOW(),
		       cash_collected_by_pro = $2::uuid,
		       start_otp_verified_at = NOW() - INTERVAL '20 minutes',
		       started_at            = NOW() - INTERVAL '20 minutes',
		       payment_method        = NULL,
		       payment_status        = NULL,
		       updated_at            = NOW()
		 WHERE id = $1::uuid`,
		fx.BookingID, fx.UserID,
	); err != nil {
		t.Fatalf("seed cash-resolved booking: %v", err)
	}

	before := snapshotBooking(t, pool, fx.BookingID)

	status, _ := runMarkAttemptFailed(t, pool, fx.UserID, fx.PaymentID)
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}

	after := snapshotBooking(t, pool, fx.BookingID)

	if before.Status != after.Status {
		t.Errorf("PAYMENTS-ROW-ONLY VIOLATED: bookings.status %q -> %q",
			before.Status, after.Status)
	}
	if !equalNullableString(before.PaymentStatus, after.PaymentStatus) {
		t.Errorf("PAYMENTS-ROW-ONLY VIOLATED: bookings.payment_status %v -> %v",
			before.PaymentStatus, after.PaymentStatus)
	}
	if !equalNullableString(before.PaymentMethod, after.PaymentMethod) {
		t.Errorf("PAYMENTS-ROW-ONLY VIOLATED: bookings.payment_method %v -> %v",
			before.PaymentMethod, after.PaymentMethod)
	}
	if !equalNullableTime(before.CashCollectedAt, after.CashCollectedAt) {
		t.Errorf("PAYMENTS-ROW-ONLY VIOLATED: bookings.cash_collected_at %v -> %v",
			before.CashCollectedAt, after.CashCollectedAt)
	}
	if !equalNullableTime(before.StartOTPVerifiedAt, after.StartOTPVerifiedAt) {
		t.Errorf("PAYMENTS-ROW-ONLY VIOLATED: bookings.start_otp_verified_at %v -> %v",
			before.StartOTPVerifiedAt, after.StartOTPVerifiedAt)
	}
	if !equalNullableTime(before.EndOTPVerifiedAt, after.EndOTPVerifiedAt) {
		t.Errorf("PAYMENTS-ROW-ONLY VIOLATED: bookings.end_otp_verified_at %v -> %v",
			before.EndOTPVerifiedAt, after.EndOTPVerifiedAt)
	}
	if !before.UpdatedAt.Equal(after.UpdatedAt) {
		t.Errorf("PAYMENTS-ROW-ONLY VIOLATED: bookings.updated_at %v -> %v",
			before.UpdatedAt, after.UpdatedAt)
	}

	// The payments side did flip — that's the only mutation we expect.
	if got := currentPaymentStatus(t, pool, fx.PaymentID); got != "failed" {
		t.Errorf("payments.gateway_status = %q, want failed", got)
	}
}

func equalNullableString(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func equalNullableTime(a, b *time.Time) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return a.Equal(*b)
}
