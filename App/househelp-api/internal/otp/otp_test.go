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
