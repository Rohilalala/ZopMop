package auth

// Integration test for Message Central VerifyNow against the REAL API.
//
// WARNING — this test uses PRODUCTION credentials and sends a REAL SMS.
// Each run costs approximately ₹0.30 in OTP charges. It is intended for
// manual local verification ONLY and never runs in CI.
//
// Run it explicitly with real creds:
//   MC_INTEGRATION_TEST=1 \
//   MC_CUSTOMER_ID=... MC_AUTH_TOKEN=... MC_TEST_PHONE=+91XXXXXXXXXX \
//   go test ./internal/auth/ -run TestMC_Integration -v -count=1

import (
	"context"
	"os"
	"testing"
)

func TestMC_Integration_SendOTP(t *testing.T) {
	if os.Getenv("MC_INTEGRATION_TEST") != "1" {
		t.Skip("set MC_INTEGRATION_TEST=1 to run (sends a real SMS, ~₹0.30)")
	}
	cust, tok, phone := os.Getenv("MC_CUSTOMER_ID"), os.Getenv("MC_AUTH_TOKEN"), os.Getenv("MC_TEST_PHONE")
	if cust == "" || tok == "" || phone == "" {
		t.Fatal("MC_CUSTOMER_ID, MC_AUTH_TOKEN, MC_TEST_PHONE required")
	}
	c := NewMessageCentralClient(MessageCentralConfig{CustomerID: cust, AuthToken: tok})
	vid, err := c.SendOTP(context.Background(), phone)
	if err != nil {
		t.Fatalf("real SendOTP failed: %v", err)
	}
	t.Logf("real verificationId = %s — check the SMS, then validate manually", vid)
}
