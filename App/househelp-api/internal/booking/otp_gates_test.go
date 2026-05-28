package booking

// otp_gates_test.go — unit tests for the two-OTP payment-gated service flow
// (Phase 1 Step 1). Focused on the EARLY-BAIL paths that don't touch the
// database. The happy-path SQL execution (gate passes → UPDATE bookings) is
// covered by the end-to-end integration smoke against the live stack.
//
// All gate rejections must happen BEFORE any SQL Exec runs — an invalid OTP
// or unwired service must not leave any trace on the booking row.
//
// The three rejection axes tested here:
//
//  1. service not wired (s.otpSvc == nil) → ErrOTPServiceNotWired
//  2. empty/blank code                    → ErrStartOTPRequired / ErrEndOTPRequired
//  3. wrong code or no outstanding code   → ErrInvalidStartOTP / ErrInvalidEndOTP
//     (whether the underlying otp pkg returns ErrNotFound or ErrMismatch is
//     intentionally collapsed into the same gate error to avoid leaking
//     "we did issue an OTP but you typed wrong" vs "no OTP outstanding".)

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/adityarohilla/househelp-api/internal/otp"
)

func newOTPGatedService(t *testing.T) (*Service, *otp.Service) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	otpSvc := otp.New(rdb, time.Minute)
	svc := &Service{}
	svc.SetOTPService(otpSvc)
	return svc, otpSvc
}

func TestStartBooking_OTPServiceNotWired(t *testing.T) {
	t.Parallel()
	svc := &Service{}
	err := svc.StartBooking(context.Background(), "booking-1", "helper-1", "123456")
	if !errors.Is(err, ErrOTPServiceNotWired) {
		t.Fatalf("err = %v, want ErrOTPServiceNotWired", err)
	}
}

func TestStartBooking_EmptyOTPRejected(t *testing.T) {
	t.Parallel()
	svc, _ := newOTPGatedService(t)
	err := svc.StartBooking(context.Background(), "booking-1", "helper-1", "")
	if !errors.Is(err, ErrStartOTPRequired) {
		t.Fatalf("err = %v, want ErrStartOTPRequired", err)
	}
}

func TestStartBooking_WrongCodeRejected(t *testing.T) {
	t.Parallel()
	svc, otpSvc := newOTPGatedService(t)
	ctx := context.Background()
	if _, err := otpSvc.Issue(ctx, otp.ScopeStart, "booking-1"); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	err := svc.StartBooking(ctx, "booking-1", "helper-1", "000000")
	if !errors.Is(err, ErrInvalidStartOTP) {
		t.Fatalf("err = %v, want ErrInvalidStartOTP", err)
	}
}

func TestStartBooking_NoOutstandingOTPRejected(t *testing.T) {
	t.Parallel()
	svc, _ := newOTPGatedService(t)
	err := svc.StartBooking(context.Background(), "booking-1", "helper-1", "123456")
	if !errors.Is(err, ErrInvalidStartOTP) {
		t.Fatalf("err = %v, want ErrInvalidStartOTP (no code outstanding)", err)
	}
}

func TestCompleteBooking_OTPServiceNotWired(t *testing.T) {
	t.Parallel()
	svc := &Service{}
	err := svc.CompleteBooking(context.Background(), "booking-1", "helper-1", "123456")
	if !errors.Is(err, ErrOTPServiceNotWired) {
		t.Fatalf("err = %v, want ErrOTPServiceNotWired", err)
	}
}

func TestCompleteBooking_EmptyOTPRejected(t *testing.T) {
	t.Parallel()
	svc, _ := newOTPGatedService(t)
	err := svc.CompleteBooking(context.Background(), "booking-1", "helper-1", "")
	if !errors.Is(err, ErrEndOTPRequired) {
		t.Fatalf("err = %v, want ErrEndOTPRequired", err)
	}
}

func TestCompleteBooking_WrongCodeRejected(t *testing.T) {
	t.Parallel()
	svc, otpSvc := newOTPGatedService(t)
	ctx := context.Background()
	if _, err := otpSvc.Issue(ctx, otp.ScopeEnd, "booking-1"); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	err := svc.CompleteBooking(ctx, "booking-1", "helper-1", "000000")
	if !errors.Is(err, ErrInvalidEndOTP) {
		t.Fatalf("err = %v, want ErrInvalidEndOTP", err)
	}
}

func TestCompleteBooking_NoOutstandingOTPRejected(t *testing.T) {
	t.Parallel()
	svc, _ := newOTPGatedService(t)
	err := svc.CompleteBooking(context.Background(), "booking-1", "helper-1", "123456")
	if !errors.Is(err, ErrInvalidEndOTP) {
		t.Fatalf("err = %v, want ErrInvalidEndOTP (no code outstanding)", err)
	}
}

// One-time-use is structurally guaranteed by the otp package itself —
// internal/otp/otp_test.go::TestVerify_OneTimeUse pins that property. The
// booking gate doesn't need to re-test it; the booking layer's contract is
// "call otp.Verify, fail closed on any error". Trying to re-test it here
// requires the SQL Exec to succeed on the first call (so the code is
// consumed) which means a real DB harness — out of scope for this unit
// test file. The integration smoke against the live stack covers the
// happy-path end-to-end.
