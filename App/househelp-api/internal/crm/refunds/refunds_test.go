package refunds

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/payments"
)

// countingGateway is a payments.Gateway test double that counts how many
// times Refund was invoked and records every idempotency key it received.
// Used to verify that the row-level CAS lock prevents the gateway from
// being called more than once when concurrent Approve/Retry clicks land
// on the same refund row (audit B1-1 regression net).
type countingGateway struct {
	calls atomic.Int64
	keys  sync.Map // idempotencyKey -> struct{}
}

func (g *countingGateway) Name() string { return "counting-test" }

func (g *countingGateway) Refund(_ context.Context, _ string, _ int64, _ payments.PaymentMethod, idempotencyKey string) (*payments.RefundResult, error) {
	g.calls.Add(1)
	g.keys.Store(idempotencyKey, struct{}{})
	return &payments.RefundResult{
		GatewayRefundID: "cf-test-" + idempotencyKey,
		StatusCode:      200,
	}, nil
}

func openRefundsTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed refunds tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

func ensureTestUser(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	// Derive phone from the LAST 8 chars of the UUID. Two tests using UUIDs
	// that share a common prefix (e.g. 33330000-…-001 vs 33330000-…-002)
	// would otherwise produce identical phones and trip users_phone_key.
	// users.phone is VARCHAR(20); "test-rfnd-" + 8 chars = 18 chars, fits.
	phone := "test-rfnd-" + userID[len(userID)-8:]
	_, err := pool.Exec(context.Background(), `
		INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')
		ON CONFLICT (id) DO NOTHING
	`, userID, phone)
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
}

func makeRefundRow(t *testing.T, pool *pgxpool.Pool, userID, refundID, status string) {
	t.Helper()
	// Clean up any prior row with this id from a partial previous run before
	// inserting. payment_method=upi + payment_id forces runGateway to take
	// the gateway path (not the COD/wallet/manual short-circuits).
	_, _ = pool.Exec(context.Background(), `DELETE FROM pending_refunds WHERE id=$1::uuid`, refundID)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO pending_refunds (id, user_id, amount_cents, source, status, payment_method, payment_id)
		VALUES ($1::uuid, $2::uuid, 1000, 'test', $3, 'upi', 'order-test-123')
	`, refundID, userID, status)
	if err != nil {
		t.Fatalf("insert refund row: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM pending_refunds WHERE id=$1::uuid`, refundID)
	})
}

// newRefundsTestApp wires the Handler with a mock gateway and registers
// Approve + Retry directly, bypassing the auth/permission middleware. We
// also intentionally leave crmAdminID Locals unset so approveUpdate skips
// the approved_by FK column (no need to seed crm_admins in the test DB).
func newRefundsTestApp(repo *Repository, gw payments.Gateway) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	h := NewHandler(repo, nil)
	h.SetGateway(gw)
	app.Post("/refunds/:id/approve", h.Approve)
	app.Post("/refunds/:id/retry", h.Retry)
	return app
}

func raceCallApprove(t *testing.T, app *fiber.App, refundID string, n int) []int {
	t.Helper()
	var wg sync.WaitGroup
	statuses := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/refunds/"+refundID+"/approve",
				strings.NewReader(`{"reason":"double-click test"}`))
			req.Header.Set("Content-Type", "application/json")
			r, err := app.Test(req, -1)
			if err != nil {
				t.Errorf("call %d: %v", i, err)
				return
			}
			statuses[i] = r.StatusCode
			_ = r.Body.Close()
		}(i)
	}
	wg.Wait()
	return statuses
}

func raceCallRetry(t *testing.T, app *fiber.App, refundID string, n int) []int {
	t.Helper()
	var wg sync.WaitGroup
	statuses := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/refunds/"+refundID+"/retry",
				strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			r, err := app.Test(req, -1)
			if err != nil {
				t.Errorf("call %d: %v", i, err)
				return
			}
			statuses[i] = r.StatusCode
			_ = r.Body.Close()
		}(i)
	}
	wg.Wait()
	return statuses
}

// tallyStatuses splits responses into "winner" (200), "loser" (400 or 409),
// and "broken" (anything else, notably 5xx). Two distinct loser codes are
// expected and both legal:
//   - 409 — the goroutine reached lockForApproval and lost the CAS.
//   - 400 — the goroutine read current.Status before the CAS but after the
//     winner had already flipped pending→approved, so the pre-CAS
//     "status != pending" guard returned 400. Same semantic outcome as 409
//     ("you didn't win"), different status code.
//
// The race-fix contract is "exactly one OK, zero 5xx, all others lost
// gracefully". The handler-level split between 400/409 is incidental.
func tallyStatuses(statuses []int) (ok, loser, broken int) {
	for _, s := range statuses {
		switch {
		case s == fiber.StatusOK:
			ok++
		case s == fiber.StatusBadRequest, s == fiber.StatusConflict:
			loser++
		default:
			broken++
		}
	}
	return
}

func TestApprove_ConcurrentDoubleClick(t *testing.T) {
	pool := openRefundsTestDB(t)
	repo := NewRepository(pool, pool)
	const userID = "33330000-0000-0000-0000-000000000001"
	const refundID = "33331111-1111-1111-1111-111111111111"
	ensureTestUser(t, pool, userID)
	makeRefundRow(t, pool, userID, refundID, "pending")

	gw := &countingGateway{}
	app := newRefundsTestApp(repo, gw)

	const N = 10
	statuses := raceCallApprove(t, app, refundID, N)

	if got := gw.calls.Load(); got != 1 {
		t.Fatalf("gateway calls = %d, want exactly 1 (TOCTOU regression)", got)
	}
	if _, found := gw.keys.Load(refundID); !found {
		t.Fatalf("gateway received wrong idempotency key; expected the refund row UUID %q", refundID)
	}

	ok, loser, broken := tallyStatuses(statuses)
	if ok != 1 {
		t.Fatalf("expected exactly 1 OK, got ok=%d loser=%d broken=%d statuses=%v", ok, loser, broken, statuses)
	}
	if broken != 0 {
		t.Fatalf("expected zero 5xx/unexpected, got broken=%d statuses=%v", broken, statuses)
	}
	if loser != N-1 {
		t.Fatalf("expected %d losers (400 or 409), got %d statuses=%v", N-1, loser, statuses)
	}

	var finalStatus string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM pending_refunds WHERE id=$1::uuid`, refundID).Scan(&finalStatus); err != nil {
		t.Fatalf("read final status: %v", err)
	}
	if finalStatus != "processed" {
		t.Fatalf("final status = %q, want processed", finalStatus)
	}
}

func TestRetry_ConcurrentDoubleClick(t *testing.T) {
	pool := openRefundsTestDB(t)
	repo := NewRepository(pool, pool)
	const userID = "33330000-0000-0000-0000-000000000002"
	const refundID = "33332222-2222-2222-2222-222222222222"
	ensureTestUser(t, pool, userID)
	makeRefundRow(t, pool, userID, refundID, "gateway_error")

	gw := &countingGateway{}
	app := newRefundsTestApp(repo, gw)

	const N = 10
	statuses := raceCallRetry(t, app, refundID, N)

	if got := gw.calls.Load(); got != 1 {
		t.Fatalf("retry: gateway calls = %d, want exactly 1", got)
	}
	if _, found := gw.keys.Load(refundID); !found {
		t.Fatalf("retry: gateway received wrong idempotency key")
	}

	ok, conflict, other := tallyStatuses(statuses)
	if ok != 1 {
		t.Fatalf("retry: expected exactly 1 OK, got ok=%d conflict=%d other=%d statuses=%v", ok, conflict, other, statuses)
	}
	if conflict != N-1 {
		t.Fatalf("retry: expected %d conflicts, got %d (statuses=%v)", N-1, conflict, statuses)
	}

	var finalStatus string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM pending_refunds WHERE id=$1::uuid`, refundID).Scan(&finalStatus); err != nil {
		t.Fatalf("read final status: %v", err)
	}
	if finalStatus != "processed" {
		t.Fatalf("retry final status = %q, want processed", finalStatus)
	}
}
