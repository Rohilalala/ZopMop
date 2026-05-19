package auth

// service_otp_test.go — unit tests for the Message Central OTP service-layer
// behaviours introduced in the MSG91→Message Central swap.
//
// Two tests cover the two NEW behaviours:
//
//  1. TestSendLoginOTP_StoresVerificationID — asserts that after a successful
//     SendLoginOTP call the vendor's verificationId is written at
//     "otp:vid:{phone}" in Redis. SKIPPED: Repository.GetUserByPhone requires
//     a live Postgres connection (pgxpool.Pool wraps pgx; no in-memory
//     substitute exists for pgx). The vendor-side behaviour is already
//     exercised in messagecentral_test.go; this path is covered by the
//     make-preflight smoke + integration test (Task 5).
//
//  2. TestVerifyLoginOTP_MissingVID_ReturnsErrInvalidOTP — asserts that when
//     no verificationId is stored in Redis, VerifyLoginOTP returns ErrInvalidOTP.
//     This preserves the 401 INVALID_OTP mobile contract documented in the spec.
//     Pure unit test: miniredis + fake vendor only, no Postgres required.

import (
	"context"
	"errors"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// fakeVendor is a minimal otpVendor stub for service-layer unit tests.
// It never makes network calls.
type fakeVendor struct {
	sendVID   string
	sendErr   error
	verifyErr error
	gotVID    string
}

func (f *fakeVendor) SendOTP(_ context.Context, _ string) (string, error) {
	return f.sendVID, f.sendErr
}

func (f *fakeVendor) VerifyOTP(_ context.Context, vid, _ string) error {
	f.gotVID = vid
	return f.verifyErr
}

func (f *fakeVendor) RetryOTP(_ context.Context, _ string) error { return nil }
func (f *fakeVendor) DevMode() bool                              { return false }

// TestSendLoginOTP_StoresVerificationID is skipped because
// Repository.GetUserByPhone requires a live Postgres pool (pgxpool.Pool; the
// concrete struct wraps pgx — there is no in-memory substitute). The vendor
// behaviour is covered by TestMC_SendReturnsVerificationID in
// messagecentral_test.go, and the full end-to-end flow is covered by the
// integration test in Task 5.
func TestSendLoginOTP_StoresVerificationID(t *testing.T) {
	t.Skip("Repository.GetUserByPhone requires Postgres (pgxpool.Pool); " +
		"covered by messagecentral_test.go (vendor layer) and Task-5 integration test")
}

// TestVerifyLoginOTP_MissingVID_ReturnsErrInvalidOTP asserts that
// VerifyLoginOTP returns ErrInvalidOTP when there is no verificationId stored
// in Redis for the given phone. This is the contract-critical 401 INVALID_OTP
// path that the mobile client depends on.
//
// Wiring:
//   - rdb:     miniredis-backed *redis.Client (no stored vid → redis.Nil branch)
//   - otp:     *fakeVendor (non-nil; satisfies the nil-guard; never called on
//     this code path because we return before s.otp.VerifyOTP)
//   - rate:    *OTPRateLimiter backed by the same miniredis client; CheckVerify
//     is Redis-only and passes cleanly on an empty keyspace
//   - tokens:  &TokenIssuer{} — zero-value non-nil pointer; only dereferenced
//     inside issueTokenPair which is never reached on this path
//   - refresh: &RefreshRepo{} — zero-value non-nil pointer; same rationale
func TestVerifyLoginOTP_MissingVID_ReturnsErrInvalidOTP(t *testing.T) {
	t.Parallel()

	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	svc := &Service{
		rdb:  rdb,
		rate: NewOTPRateLimiter(rdb),
		// tokens and refresh are only dereferenced after the redis.Nil early
		// return; zero-value non-nil structs satisfy the nil-guard without
		// being called on this code path.
		tokens:  &TokenIssuer{},
		refresh: &RefreshRepo{},
	}
	svc.SetOTPVendor(&fakeVendor{})

	ctx := context.Background()
	_, err := svc.VerifyLoginOTP(ctx, "+919876543210", "123456", false)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, ErrInvalidOTP) {
		t.Fatalf("err = %v, want ErrInvalidOTP", err)
	}
}
