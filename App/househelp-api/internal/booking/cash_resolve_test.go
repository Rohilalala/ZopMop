package booking

// cash_resolve_test.go — early-bail rejection paths for ResolveCash
// (Phase 1 Step 3). The happy path and the SQL guards (status checks,
// pending-Cashfree-order check, helper_id snapshot) need a real DB and
// are exercised by the integration smoke against the live stack.
//
// What we CAN test here without a DB:
//
//   - ErrOTPServiceNotWired when SetOTPService was never called.
//
// Every other rejection path runs after the SELECT FOR UPDATE on the
// bookings row, which requires a real pool. Those are covered by the
// happy/sad-path smokes in Step 6.

import (
	"context"
	"errors"
	"testing"
)

func TestResolveCash_OTPServiceNotWired(t *testing.T) {
	t.Parallel()
	svc := &Service{}
	err := svc.ResolveCash(context.Background(), "booking-1", "customer-1")
	if !errors.Is(err, ErrOTPServiceNotWired) {
		t.Fatalf("err = %v, want ErrOTPServiceNotWired", err)
	}
}
