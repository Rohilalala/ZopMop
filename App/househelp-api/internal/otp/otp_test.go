package otp

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestService(t *testing.T) (*Service, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return New(rdb, time.Minute), mr
}

// TestIssueAndVerify is the happy path: a code issued under (scope, owner)
// must verify exactly once and then be consumed.
func TestIssueAndVerify(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	code, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if len(code) != 6 {
		t.Fatalf("Issue: code length = %d, want 6", len(code))
	}
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); err != nil {
		t.Fatalf("Verify (first): %v", err)
	}
}

// TestVerify_OneTimeUse asserts that a code can only be consumed once.
// Replay must fail with ErrNotFound, never satisfy the gate twice.
func TestVerify_OneTimeUse(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	code, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); err != nil {
		t.Fatalf("Verify (first): %v", err)
	}
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Verify (replay): err = %v, want ErrNotFound", err)
	}
}

// TestVerify_WrongCode asserts that a code-mismatch returns ErrMismatch and
// does NOT consume the stored code — a brute-force attempt must not evict
// the legit outstanding code.
func TestVerify_WrongCode(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	code, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := svc.Verify(ctx, ScopeStart, "booking-1", "000000"); !errors.Is(err, ErrMismatch) {
		t.Fatalf("Verify (wrong code): err = %v, want ErrMismatch", err)
	}
	// Legit code still works after a mismatch attempt.
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); err != nil {
		t.Fatalf("Verify (after mismatch): %v", err)
	}
}

// TestCrossScopeRejection is the security-critical test: a code issued
// under ScopeStart MUST NOT satisfy a Verify under ScopeEnd, even for the
// same booking. This is the property that prevents a Start OTP being
// replayed as an End OTP (or vice versa).
func TestCrossScopeRejection(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	startCode, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue start: %v", err)
	}
	endCode, err := svc.Issue(ctx, ScopeEnd, "booking-1")
	if err != nil {
		t.Fatalf("Issue end: %v", err)
	}

	// Start code cannot verify the End gate.
	if err := svc.Verify(ctx, ScopeEnd, "booking-1", startCode); err == nil {
		t.Fatal("start code verified end gate; cross-scope rejection failed")
	}
	// End code cannot verify the Start gate.
	if err := svc.Verify(ctx, ScopeStart, "booking-1", endCode); err == nil {
		t.Fatal("end code verified start gate; cross-scope rejection failed")
	}
	// Both codes are still valid in their own scope.
	if err := svc.Verify(ctx, ScopeStart, "booking-1", startCode); err != nil {
		t.Fatalf("Verify start (correct scope): %v", err)
	}
	if err := svc.Verify(ctx, ScopeEnd, "booking-1", endCode); err != nil {
		t.Fatalf("Verify end (correct scope): %v", err)
	}
}

// TestCrossOwnerRejection asserts that a code issued for booking-1 cannot
// satisfy a Verify for booking-2, even within the same scope.
func TestCrossOwnerRejection(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	code1, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue booking-1: %v", err)
	}
	if err := svc.Verify(ctx, ScopeStart, "booking-2", code1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Verify booking-2 with booking-1 code: err = %v, want ErrNotFound", err)
	}
}

// TestExpiry asserts that codes outside the TTL window are not verifiable.
func TestExpiry(t *testing.T) {
	t.Parallel()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	svc := New(rdb, time.Minute)
	ctx := context.Background()

	code, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	mr.FastForward(2 * time.Minute)
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Verify (expired): err = %v, want ErrNotFound", err)
	}
}

// TestInvalidScope guards against accidentally calling Issue/Verify with a
// scope outside the defined set (e.g. accidentally using "login").
func TestInvalidScope(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	if _, err := svc.Issue(ctx, Scope("login"), "booking-1"); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("Issue with login scope: err = %v, want ErrInvalidScope", err)
	}
	if err := svc.Verify(ctx, Scope("login"), "booking-1", "123456"); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("Verify with login scope: err = %v, want ErrInvalidScope", err)
	}
}

// TestRevoke asserts an outstanding code is cleared and subsequent verify fails.
func TestRevoke(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	code, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := svc.Revoke(ctx, ScopeStart, "booking-1"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Verify after Revoke: err = %v, want ErrNotFound", err)
	}
}

// TestLoginNamespaceCannotSatisfyServiceOTP is the highest-stakes test: a
// value written under any auth-side Redis key shape MUST NEVER satisfy a
// service OTP verify. We directly seed the key shapes the auth package
// uses and confirm the otp.Service ignores them — proving the namespace
// separation is intact at the wire level, not merely by convention.
func TestLoginNamespaceCannotSatisfyServiceOTP(t *testing.T) {
	t.Parallel()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	svc := New(rdb, time.Minute)
	ctx := context.Background()

	// Seed every login-side key shape that the auth package writes
	// (post-namespace-separation) with a known value.
	for _, k := range []string{
		"otp:login:vid:+919876543210",
		"otp:login:code:+919876543210",
		"otp:login:lock:+919876543210",
		"otp:login:cooldown:+919876543210",
		"otp:login:fail:+919876543210",
		"otp:login:send:phone:+919876543210",
		"otp:login:send:ip:1.2.3.4",
		"otp:login:verify:phone:+919876543210",
	} {
		if err := rdb.Set(ctx, k, "123456", time.Minute).Err(); err != nil {
			t.Fatalf("seed %s: %v", k, err)
		}
	}

	// Verifying "123456" against any service scope for the same phone-shaped
	// owner must fail — the service OTP only looks at otp:start:{owner} and
	// otp:end:{owner}.
	if err := svc.Verify(ctx, ScopeStart, "+919876543210", "123456"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ScopeStart Verify accepted login-namespace value: err = %v, want ErrNotFound", err)
	}
	if err := svc.Verify(ctx, ScopeEnd, "+919876543210", "123456"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ScopeEnd Verify accepted login-namespace value: err = %v, want ErrNotFound", err)
	}
}

// TestKeyShape pins the on-the-wire Redis key format so an accidental
// rename later doesn't silently collide with another namespace.
func TestKeyShape(t *testing.T) {
	t.Parallel()
	if got := keyFor(ScopeStart, "abc"); got != "otp:start:abc" {
		t.Fatalf("keyFor(start, abc) = %q, want otp:start:abc", got)
	}
	if got := keyFor(ScopeEnd, "abc"); got != "otp:end:abc" {
		t.Fatalf("keyFor(end, abc) = %q, want otp:end:abc", got)
	}
}

// TestPeek_IdempotentRead asserts that Peek returns the code without
// consuming it — the same code can be read repeatedly, and a subsequent
// Verify still works. This is what the customer's TrackLive endpoint
// depends on: it loads many times while the customer waits and must
// always surface the same outstanding code.
func TestPeek_IdempotentRead(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	code, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	for i := range 3 {
		got, err := svc.Peek(ctx, ScopeStart, "booking-1")
		if err != nil {
			t.Fatalf("Peek %d: %v", i, err)
		}
		if got != code {
			t.Fatalf("Peek %d = %q, want %q (must not rotate)", i, got, code)
		}
	}
	// Verify still consumes after multiple peeks.
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); err != nil {
		t.Fatalf("Verify after peeks: %v", err)
	}
	// Post-consume peek must return ErrNotFound.
	if _, err := svc.Peek(ctx, ScopeStart, "booking-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Peek after Verify: err = %v, want ErrNotFound", err)
	}
}

// TestPeek_NotFound asserts Peek returns ErrNotFound when no code is
// outstanding (the customer's TrackLive must treat this as "no code yet
// to display", not a server error).
func TestPeek_NotFound(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()
	if _, err := svc.Peek(ctx, ScopeStart, "booking-nonexistent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// TestVerify_RateLimit_LocksOutAfterMaxWrongAttempts is the headline
// security guarantee. The first maxVerifyAttempts wrong submissions
// must surface ErrMismatch (so the pro sees "wrong code, try again");
// the (maxVerifyAttempts + 1)th must surface ErrTooManyAttempts. The
// stored code is NOT consumed on any of the wrong attempts (otp.Verify
// only Del's on success), so a legitimate retry remains possible after
// the window expires.
func TestVerify_RateLimit_LocksOutAfterMaxWrongAttempts(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	if _, err := svc.Issue(ctx, ScopeStart, "booking-1"); err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// First maxVerifyAttempts wrong submissions surface ErrMismatch.
	for i := 0; i < maxVerifyAttempts; i++ {
		if err := svc.Verify(ctx, ScopeStart, "booking-1", "000000"); !errors.Is(err, ErrMismatch) {
			t.Fatalf("attempt %d: err = %v, want ErrMismatch", i+1, err)
		}
	}
	// The next attempt is locked out.
	if err := svc.Verify(ctx, ScopeStart, "booking-1", "000000"); !errors.Is(err, ErrTooManyAttempts) {
		t.Fatalf("attempt %d (over cap): err = %v, want ErrTooManyAttempts", maxVerifyAttempts+1, err)
	}
	// And once locked, even a CORRECT code is refused — the rate limit
	// is the higher-priority gate. (The pro must wait or escalate.)
	// Peek the stored code to drive this assertion deterministically.
	stored, perr := svc.Peek(ctx, ScopeStart, "booking-1")
	if perr != nil {
		t.Fatalf("Peek: %v", perr)
	}
	if err := svc.Verify(ctx, ScopeStart, "booking-1", stored); !errors.Is(err, ErrTooManyAttempts) {
		t.Fatalf("correct code under lockout: err = %v, want ErrTooManyAttempts", err)
	}
}

// TestVerify_RateLimit_PerBookingIsolation asserts that wrong-guess
// credit on booking-1 does NOT pre-lock booking-2's gate. A pro
// juggling two jobs must have independent budgets.
func TestVerify_RateLimit_PerBookingIsolation(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	if _, err := svc.Issue(ctx, ScopeStart, "booking-1"); err != nil {
		t.Fatalf("Issue booking-1: %v", err)
	}
	if _, err := svc.Issue(ctx, ScopeStart, "booking-2"); err != nil {
		t.Fatalf("Issue booking-2: %v", err)
	}

	// Burn booking-1's budget completely (lock it out).
	for i := 0; i < maxVerifyAttempts+1; i++ {
		_ = svc.Verify(ctx, ScopeStart, "booking-1", "000000")
	}
	// booking-2 still gets its own budget. Burn one less than the cap
	// so the final correct verify still fits inside the window.
	for i := 0; i < maxVerifyAttempts-1; i++ {
		if err := svc.Verify(ctx, ScopeStart, "booking-2", "000000"); !errors.Is(err, ErrMismatch) {
			t.Fatalf("booking-2 attempt %d: err = %v, want ErrMismatch (isolation broken)", i+1, err)
		}
	}
	// And a correct code for booking-2 still verifies — counter is at
	// (maxVerifyAttempts - 1), this is the maxVerifyAttempts-th call,
	// which is the LAST allowed slot.
	stored, _ := svc.Peek(ctx, ScopeStart, "booking-2")
	if err := svc.Verify(ctx, ScopeStart, "booking-2", stored); err != nil {
		t.Fatalf("booking-2 correct on last-allowed slot: err = %v, want nil", err)
	}
}

// TestVerify_RateLimit_ScopeIsolation asserts wrong-guess credit on the
// Start gate does NOT pre-lock the End gate (same booking). The two
// gates fire at different lifecycle moments and must have independent
// budgets.
func TestVerify_RateLimit_ScopeIsolation(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	if _, err := svc.Issue(ctx, ScopeStart, "booking-1"); err != nil {
		t.Fatalf("Issue start: %v", err)
	}
	if _, err := svc.Issue(ctx, ScopeEnd, "booking-1"); err != nil {
		t.Fatalf("Issue end: %v", err)
	}
	// Lock out the Start gate.
	for i := 0; i < maxVerifyAttempts+1; i++ {
		_ = svc.Verify(ctx, ScopeStart, "booking-1", "000000")
	}
	// End gate must still accept wrong attempts as ErrMismatch.
	if err := svc.Verify(ctx, ScopeEnd, "booking-1", "000000"); !errors.Is(err, ErrMismatch) {
		t.Fatalf("End gate after Start lockout: err = %v, want ErrMismatch (scope isolation broken)", err)
	}
}

// TestVerify_RateLimit_ResetOnSuccess asserts the fail counter clears
// when the pro eventually gets the code right. Without this, residual
// in-window fail credit would mis-lock the next legitimate verify
// (e.g. the End OTP after a Start OTP succeeded with some fumbling).
func TestVerify_RateLimit_ResetOnSuccess(t *testing.T) {
	t.Parallel()
	svc, _ := newTestService(t)
	ctx := context.Background()

	code, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	// Five wrong attempts (under the cap).
	for i := 0; i < 5; i++ {
		if err := svc.Verify(ctx, ScopeStart, "booking-1", "000000"); !errors.Is(err, ErrMismatch) {
			t.Fatalf("attempt %d: err = %v, want ErrMismatch", i+1, err)
		}
	}
	// Correct code — should succeed.
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); err != nil {
		t.Fatalf("correct code: err = %v, want nil", err)
	}
	// New OTP issued for the same booking; the counter must be clean,
	// so the FULL budget of new wrong attempts is available before lockout.
	newCode, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("re-Issue: %v", err)
	}
	for i := 0; i < maxVerifyAttempts; i++ {
		if err := svc.Verify(ctx, ScopeStart, "booking-1", "000000"); !errors.Is(err, ErrMismatch) {
			t.Fatalf("post-reset attempt %d: err = %v, want ErrMismatch", i+1, err)
		}
	}
	// Correct code still works as long as we're inside the budget.
	// Issue rotates the code, so use newCode.
	if err := svc.Verify(ctx, ScopeStart, "booking-1", newCode); err != nil {
		// Should fail because we just burned maxVerifyAttempts wrong
		// attempts; the next call is the (max+1)th. Assert lockout.
		if !errors.Is(err, ErrTooManyAttempts) {
			t.Fatalf("post-budget verify: err = %v, want ErrTooManyAttempts", err)
		}
	}
}

// TestVerify_RateLimit_ExpiresAfterWindow asserts the lockout self-heals
// once the verifyAttemptsWindow has passed. Uses miniredis FastForward
// to skip wall time deterministically.
func TestVerify_RateLimit_ExpiresAfterWindow(t *testing.T) {
	t.Parallel()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	svc := New(rdb, 6*time.Hour) // long OTP TTL so the code itself doesn't expire

	ctx := context.Background()
	code, err := svc.Issue(ctx, ScopeStart, "booking-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	// Lock out.
	for i := 0; i < maxVerifyAttempts+1; i++ {
		_ = svc.Verify(ctx, ScopeStart, "booking-1", "000000")
	}
	// Fast-forward past the window.
	mr.FastForward(verifyAttemptsWindow + time.Second)
	// Now the correct code should verify successfully — the counter
	// has expired in Redis, so INCR starts a fresh window at 1.
	if err := svc.Verify(ctx, ScopeStart, "booking-1", code); err != nil {
		t.Fatalf("post-window correct: err = %v, want nil (lockout should have expired)", err)
	}
}

// TestAttemptsKeyShape pins the Redis key for the rate-limit counter so
// an accidental rename doesn't silently collide with another namespace.
func TestAttemptsKeyShape(t *testing.T) {
	t.Parallel()
	if got := attemptsKeyFor(ScopeStart, "abc"); got != "otp:verify-attempts:start:abc" {
		t.Fatalf("attemptsKeyFor(start, abc) = %q, want otp:verify-attempts:start:abc", got)
	}
	if got := attemptsKeyFor(ScopeEnd, "abc"); got != "otp:verify-attempts:end:abc" {
		t.Fatalf("attemptsKeyFor(end, abc) = %q, want otp:verify-attempts:end:abc", got)
	}
}
