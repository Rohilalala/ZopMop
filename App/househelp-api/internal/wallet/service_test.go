package wallet

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ── Pure validation tests (no DB) ────────────────────────────────────────

func TestValidateCreditInputs_TopupRequiresPaymentID(t *testing.T) {
	t.Parallel()
	if err := ValidateCreditInputs(100, KindTopup, nil); !errors.Is(err, ErrMissingRef) {
		t.Fatalf("expected ErrMissingRef when topup paymentID is nil, got %v", err)
	}
	empty := ""
	if err := ValidateCreditInputs(100, KindTopup, &empty); !errors.Is(err, ErrMissingRef) {
		t.Fatalf("expected ErrMissingRef when topup paymentID is empty, got %v", err)
	}
	pid := "payment-123"
	if err := ValidateCreditInputs(100, KindTopup, &pid); err != nil {
		t.Fatalf("expected nil for valid topup, got %v", err)
	}
}

func TestValidateCreditInputs_RefundCreditAcceptsNilPayment(t *testing.T) {
	t.Parallel()
	if err := ValidateCreditInputs(100, KindRefundCredit, nil); err != nil {
		t.Fatalf("expected nil for refund_credit without payment_id, got %v", err)
	}
}

func TestValidateCreditInputs_AdjustmentAcceptsNilPayment(t *testing.T) {
	t.Parallel()
	if err := ValidateCreditInputs(100, KindAdjustment, nil); err != nil {
		t.Fatalf("expected nil for adjustment without payment_id, got %v", err)
	}
}

func TestValidateCreditInputs_RejectsDebitKind(t *testing.T) {
	t.Parallel()
	if err := ValidateCreditInputs(100, KindSpend, nil); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("expected ErrInvalidKind for spend in Credit, got %v", err)
	}
	if err := ValidateCreditInputs(100, KindReversal, nil); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("expected ErrInvalidKind for reversal in Credit, got %v", err)
	}
}

func TestValidateCreditInputs_RejectsUnknownKind(t *testing.T) {
	t.Parallel()
	if err := ValidateCreditInputs(100, Kind("transfer"), nil); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("expected ErrInvalidKind for transfer (forbidden), got %v", err)
	}
}

func TestValidateCreditInputs_RejectsNonPositiveAmount(t *testing.T) {
	t.Parallel()
	pid := "p"
	if err := ValidateCreditInputs(0, KindTopup, &pid); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("expected ErrInvalidAmount for 0, got %v", err)
	}
	if err := ValidateCreditInputs(-100, KindTopup, &pid); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("expected ErrInvalidAmount for negative, got %v", err)
	}
}

func TestValidateDebitInputs_SpendRequiresBookingID(t *testing.T) {
	t.Parallel()
	if err := ValidateDebitInputs(100, KindSpend, nil); !errors.Is(err, ErrMissingRef) {
		t.Fatalf("expected ErrMissingRef when spend bookingID is nil, got %v", err)
	}
	empty := ""
	if err := ValidateDebitInputs(100, KindSpend, &empty); !errors.Is(err, ErrMissingRef) {
		t.Fatalf("expected ErrMissingRef when spend bookingID is empty, got %v", err)
	}
	bid := "booking-1"
	if err := ValidateDebitInputs(100, KindSpend, &bid); err != nil {
		t.Fatalf("expected nil for valid spend, got %v", err)
	}
}

func TestValidateDebitInputs_RejectsCreditKind(t *testing.T) {
	t.Parallel()
	bid := "b"
	if err := ValidateDebitInputs(100, KindTopup, &bid); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("expected ErrInvalidKind for topup in Debit, got %v", err)
	}
	if err := ValidateDebitInputs(100, KindRefundCredit, &bid); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("expected ErrInvalidKind for refund_credit in Debit, got %v", err)
	}
}

func TestValidateDebitInputs_RejectsUnknownKind(t *testing.T) {
	t.Parallel()
	if err := ValidateDebitInputs(100, Kind("transfer"), nil); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("expected ErrInvalidKind for transfer (forbidden), got %v", err)
	}
}

func TestValidateDebitInputs_RejectsNonPositiveAmount(t *testing.T) {
	t.Parallel()
	bid := "b"
	if err := ValidateDebitInputs(0, KindSpend, &bid); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("expected ErrInvalidAmount for 0, got %v", err)
	}
	if err := ValidateDebitInputs(-100, KindSpend, &bid); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("expected ErrInvalidAmount for negative, got %v", err)
	}
}

func TestKindIsCredit(t *testing.T) {
	t.Parallel()
	credits := []Kind{KindTopup, KindRefundCredit, KindAdjustment, KindReferralCredit}
	debits := []Kind{KindSpend, KindReversal}
	for _, k := range credits {
		if !k.IsCredit() {
			t.Errorf("%s should be credit", k)
		}
	}
	for _, k := range debits {
		if k.IsCredit() {
			t.Errorf("%s should be debit", k)
		}
	}
	if Kind("transfer").IsCredit() {
		t.Errorf("transfer must never be classified as credit")
	}
}

// ── DB-backed integration tests ──────────────────────────────────────────
//
// Skipped automatically when TEST_DATABASE_URL is unset. Set it to a clean
// Postgres database for the local dev run; the suite truncates wallets +
// wallet_transactions + event_outbox between tests to keep state isolated.

func openTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping DB-backed wallet tests")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect to test DB: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// truncateWalletState wipes the wallet + outbox state for a single user so
// repeated tests don't bleed into each other. The test user id is derived
// per-test name to avoid cross-test contention.
func truncateForUser(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `DELETE FROM wallet_transactions WHERE user_id = $1::uuid`, userID); err != nil {
		t.Fatalf("truncate wallet_transactions: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM wallets WHERE user_id = $1::uuid`, userID); err != nil {
		t.Fatalf("truncate wallets: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM event_outbox WHERE aggregate_id = $1::uuid`, userID); err != nil {
		t.Fatalf("truncate event_outbox: %v", err)
	}
}

// ensureUser inserts a minimal users row so foreign-key constraints on
// wallets / wallet_transactions are satisfied. Idempotent.
func ensureUser(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO users (id, phone, role) VALUES ($1::uuid, $2, 'customer')
		ON CONFLICT (id) DO NOTHING
	`, userID, "test-"+userID[:8])
	if err != nil {
		t.Fatalf("ensure user row: %v", err)
	}
}

// withSvc is the standard fixture: opens a test DB, ensures a user row,
// truncates wallet state for that user, and returns Service + the user id.
func withSvc(t *testing.T) (*Service, string) {
	t.Helper()
	pool := openTestDB(t)
	userID := "11111111-1111-1111-1111-" + t.Name()[:6] + "00000000"
	// Substitute hyphen to keep UUID shape valid (test name might have
	// uppercase / underscores). Generate a deterministic-ish id from the
	// test name's first 6 hex-friendly chars.
	userID = makeTestUUID(t.Name())
	ensureUser(t, pool, userID)
	truncateForUser(t, pool, userID)
	t.Cleanup(func() { truncateForUser(t, pool, userID) })
	return NewService(NewRepository(pool)), userID
}

// makeTestUUID derives a deterministic UUID from a test name so parallel
// tests don't collide on the same wallet row.
func makeTestUUID(name string) string {
	// crc32 of name → 8 hex chars for first segment.
	var sum uint32 = 2166136261
	for i := 0; i < len(name); i++ {
		sum ^= uint32(name[i])
		sum *= 16777619
	}
	hex := []byte("0123456789abcdef")
	out := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		out[i] = hex[sum&0xF]
		sum >>= 4
	}
	return string(out) + "-1111-1111-1111-111111111111"
}

// Test seed credits use KindAdjustment + nil refs to avoid FK constraints
// on payments / bookings; test debits use KindReversal with nil bookingID
// for the same reason. The closed-loop validation rules are covered by the
// pure-Go tests above; these DB tests focus on the persistence + locking
// behavior of ApplyTransactionTx.

func TestApplyTransactionTx_LazyWalletCreation(t *testing.T) {
	svc, userID := withSvc(t)
	res, err := svc.Credit(context.Background(), userID, 100, KindAdjustment, nil, nil, "")
	if err != nil {
		t.Fatalf("credit: %v", err)
	}
	if res.BalanceAfter != 100 {
		t.Fatalf("balance_after = %d, want 100", res.BalanceAfter)
	}
	got, err := svc.GetBalance(context.Background(), userID)
	if err != nil {
		t.Fatalf("get balance: %v", err)
	}
	if got != 100 {
		t.Fatalf("balance = %d, want 100", got)
	}
}

func TestApplyTransactionTx_InsufficientBalance(t *testing.T) {
	svc, userID := withSvc(t)
	if _, err := svc.Credit(context.Background(), userID, 100, KindAdjustment, nil, nil, ""); err != nil {
		t.Fatalf("seed credit: %v", err)
	}
	_, err := svc.Debit(context.Background(), userID, 200, KindReversal, nil, "")
	if !errors.Is(err, ErrInsufficientBalance) {
		t.Fatalf("expected ErrInsufficientBalance, got %v", err)
	}
	bal, _ := svc.GetBalance(context.Background(), userID)
	if bal != 100 {
		t.Fatalf("balance after rejected debit = %d, want 100 (no change)", bal)
	}
}

func TestApplyTransactionTx_BalanceAfterSnapshot(t *testing.T) {
	svc, userID := withSvc(t)
	ctx := context.Background()
	if _, err := svc.Credit(ctx, userID, 100, KindAdjustment, nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Debit(ctx, userID, 30, KindReversal, nil, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Credit(ctx, userID, 50, KindRefundCredit, nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Debit(ctx, userID, 80, KindReversal, nil, ""); err != nil {
		t.Fatal(err)
	}
	got, err := svc.History(ctx, userID, 100, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	// History is reverse chronological; reverse to get insertion order.
	if len(got) != 4 {
		t.Fatalf("got %d transactions, want 4", len(got))
	}
	want := []int64{100, 70, 120, 40}
	for i, w := range want {
		// got[3-i] = oldest..newest reverse mapping
		idx := len(got) - 1 - i
		if got[idx].BalanceAfter != w {
			t.Errorf("balance_after[%d] = %d, want %d", i, got[idx].BalanceAfter, w)
		}
	}
}

// TestApplyTransactionTx_RaceCondition is the load-bearing test for the
// FOR UPDATE lock inside ApplyTransactionTx. Without the lock, two
// concurrent debits can both pass the balance check and the wallet would
// drop into a negative balance (which would also fail the CHECK, but this
// test catches it before it reaches the constraint). With the lock,
// exactly one debit must succeed.
func TestApplyTransactionTx_RaceCondition(t *testing.T) {
	svc, userID := withSvc(t)

	const iterations = 50
	for i := 0; i < iterations; i++ {
		// Reset balance to 100 each iteration.
		truncateForUser(t, svc.repo.db, userID)
		if _, err := svc.Credit(context.Background(), userID, 100, KindAdjustment, nil, nil, ""); err != nil {
			t.Fatal(err)
		}

		var (
			wg        sync.WaitGroup
			successes atomic.Int32
			ready     = make(chan struct{})
		)
		wg.Add(2)
		for g := 0; g < 2; g++ {
			go func() {
				defer wg.Done()
				<-ready // align goroutines to the same starting moment
				_, err := svc.Debit(context.Background(), userID, 80, KindReversal, nil, "")
				if err == nil {
					successes.Add(1)
				} else if !errors.Is(err, ErrInsufficientBalance) {
					t.Errorf("iter %d: unexpected err: %v", i, err)
				}
			}()
		}
		close(ready)
		wg.Wait()

		if got := successes.Load(); got != 1 {
			t.Fatalf("iter %d: %d concurrent debits succeeded, want exactly 1", i, got)
		}

		bal, err := svc.GetBalance(context.Background(), userID)
		if err != nil {
			t.Fatal(err)
		}
		if bal != 20 {
			t.Fatalf("iter %d: final balance = %d, want 20", i, bal)
		}
	}
}

// TestCreditTx_TxComposition confirms a CreditTx call participates in the
// caller's transaction — rolling back the outer tx must roll back the
// wallet write, the wallet_transactions insert, AND the wallet.credited
// outbox emit.
func TestCreditTx_TxComposition(t *testing.T) {
	svc, userID := withSvc(t)
	ctx := context.Background()

	err := pgx.BeginFunc(ctx, svc.repo.db, func(tx pgx.Tx) error {
		if _, err := svc.CreditTx(ctx, tx, userID, 1000, KindAdjustment, nil, nil, ""); err != nil {
			return err
		}
		// Force the outer tx to roll back.
		return errors.New("force rollback")
	})
	if err == nil {
		t.Fatal("expected force-rollback error")
	}

	bal, err := svc.GetBalance(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if bal != 0 {
		t.Fatalf("balance after rollback = %d, want 0", bal)
	}

	// And verify no orphaned wallet_transactions / outbox rows.
	var txCount int
	if err := svc.repo.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM wallet_transactions WHERE user_id = $1::uuid`,
		userID,
	).Scan(&txCount); err != nil {
		t.Fatal(err)
	}
	if txCount != 0 {
		t.Errorf("wallet_transactions rows after rollback = %d, want 0", txCount)
	}
	var outboxCount int
	if err := svc.repo.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM event_outbox WHERE aggregate_id = $1::uuid AND event_type = 'wallet.credited'`,
		userID,
	).Scan(&outboxCount); err != nil {
		t.Fatal(err)
	}
	if outboxCount != 0 {
		t.Errorf("event_outbox rows after rollback = %d, want 0", outboxCount)
	}
}
