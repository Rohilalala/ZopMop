package auth

// service_devmode_guard_test.go — truth-table coverage for the OTP dev-mode
// production guard. Audit finding LB-1 (2026-05-21): a stray
// OTP_DEV_MODE=true on a production deploy must not echo the plaintext OTP
// "999999" in the send-otp response. The bypass is gated on
// !s.isProduction so that even if the vendor reports DevMode()==true, a
// process booted with APP_ENV=production refuses to echo.
//
// The full SendLoginOTP path needs a live Postgres pool (see
// service_otp_test.go), so we exercise the single boolean predicate
// shouldEchoDevOTP() directly. It is the only branch upstream of the
// plaintext-OTP return.

import (
	"context"
	"testing"
)

// guardVendor is a minimal otpVendor stub that lets each test row pick the
// DevMode() return. Network methods are never called on this code path.
type guardVendor struct{ devMode bool }

func (g *guardVendor) SendOTP(_ context.Context, _ string) (string, error) { return "", nil }
func (g *guardVendor) VerifyOTP(_ context.Context, _, _ string) error      { return nil }
func (g *guardVendor) RetryOTP(_ context.Context, _ string) error          { return nil }
func (g *guardVendor) DevMode() bool                                       { return g.devMode }

func TestShouldEchoDevOTP_TruthTable(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name         string
		devMode      bool
		isProduction bool
		want         bool
	}{
		{"prod_devmode_off_no_echo", false, true, false},
		{"dev_devmode_off_no_echo", false, false, false},
		{"prod_devmode_on_BLOCKED_by_guard", true, true, false},
		{"dev_devmode_on_echoes_999999", true, false, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			svc := &Service{isProduction: tc.isProduction}
			svc.SetOTPVendor(&guardVendor{devMode: tc.devMode})

			got := svc.shouldEchoDevOTP()
			if got != tc.want {
				t.Fatalf("shouldEchoDevOTP() with devMode=%v isProduction=%v = %v, want %v",
					tc.devMode, tc.isProduction, got, tc.want)
			}
		})
	}
}

// TestShouldEchoDevOTP_NilVendor guards the nil branch — a Service whose
// otpVendor has not been wired must never claim it can echo a dev OTP.
func TestShouldEchoDevOTP_NilVendor(t *testing.T) {
	t.Parallel()
	svc := &Service{isProduction: false}
	if svc.shouldEchoDevOTP() {
		t.Fatal("shouldEchoDevOTP() with nil vendor = true, want false")
	}
}
