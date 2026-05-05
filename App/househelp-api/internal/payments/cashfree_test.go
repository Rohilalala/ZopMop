package payments

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"math"
	"strconv"
	"testing"
	"time"
)

// makeSig computes the canonical Cashfree webhook signature for a given
// secret + timestamp + body. Mirrors VerifyWebhookSignature exactly so the
// "valid" test path is provably consistent with what production checks.
func makeSig(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func newTestCashfreeGateway(t *testing.T, secret string) *CashfreeGateway {
	t.Helper()
	return &CashfreeGateway{webhookSecret: secret}
}

func TestVerifyWebhookSignature_Valid(t *testing.T) {
	t.Parallel()
	gw := newTestCashfreeGateway(t, "shhh-its-a-secret")
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	body := []byte(`{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{}}`)
	sig := makeSig("shhh-its-a-secret", ts, body)

	if err := gw.VerifyWebhookSignature(body, ts, sig); err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
}

func TestVerifyWebhookSignature_BadSignature(t *testing.T) {
	t.Parallel()
	gw := newTestCashfreeGateway(t, "shhh-its-a-secret")
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	body := []byte(`{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{}}`)
	sig := makeSig("shhh-its-a-secret", ts, body)

	// Mutate the first byte to break the HMAC. base64-padded sigs are
	// 44 chars; flipping a base64 character is enough to fail Equal.
	tampered := []byte(sig)
	if tampered[0] == 'A' {
		tampered[0] = 'B'
	} else {
		tampered[0] = 'A'
	}

	err := gw.VerifyWebhookSignature(body, ts, string(tampered))
	if !errors.Is(err, ErrWebhookBadSignature) {
		t.Fatalf("expected ErrWebhookBadSignature, got %v", err)
	}
}

func TestVerifyWebhookSignature_BadSignature_DifferentSecret(t *testing.T) {
	t.Parallel()
	gw := newTestCashfreeGateway(t, "the-correct-secret")
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	body := []byte(`{"type":"PAYMENT_SUCCESS_WEBHOOK"}`)

	// Attacker signed with a different secret.
	sig := makeSig("attacker-guessed", ts, body)

	if err := gw.VerifyWebhookSignature(body, ts, sig); !errors.Is(err, ErrWebhookBadSignature) {
		t.Fatalf("expected ErrWebhookBadSignature, got %v", err)
	}
}

func TestVerifyWebhookSignature_StaleTimestamp(t *testing.T) {
	t.Parallel()
	gw := newTestCashfreeGateway(t, "secret")
	body := []byte(`{}`)

	// 10 minutes in the past — outside the 5-minute replay window.
	stale := time.Now().Unix() - 600
	ts := strconv.FormatInt(stale, 10)
	sig := makeSig("secret", ts, body)

	err := gw.VerifyWebhookSignature(body, ts, sig)
	if !errors.Is(err, ErrWebhookStale) {
		t.Fatalf("expected ErrWebhookStale, got %v", err)
	}
}

func TestVerifyWebhookSignature_FutureTimestamp(t *testing.T) {
	t.Parallel()
	gw := newTestCashfreeGateway(t, "secret")
	body := []byte(`{}`)

	// 10 minutes in the future — clock skew the wrong way; abs() check
	// must catch it.
	future := time.Now().Unix() + 600
	ts := strconv.FormatInt(future, 10)
	sig := makeSig("secret", ts, body)

	err := gw.VerifyWebhookSignature(body, ts, sig)
	if !errors.Is(err, ErrWebhookStale) {
		t.Fatalf("expected ErrWebhookStale for future ts, got %v", err)
	}
}

func TestVerifyWebhookSignature_EmptyHeaders(t *testing.T) {
	t.Parallel()
	gw := newTestCashfreeGateway(t, "secret")
	body := []byte(`{}`)

	if err := gw.VerifyWebhookSignature(body, "", "deadbeef"); !errors.Is(err, ErrWebhookBadSignature) {
		t.Fatalf("expected ErrWebhookBadSignature for empty timestamp, got %v", err)
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	if err := gw.VerifyWebhookSignature(body, ts, ""); !errors.Is(err, ErrWebhookBadSignature) {
		t.Fatalf("expected ErrWebhookBadSignature for empty signature, got %v", err)
	}
}

func TestVerifyWebhookSignature_NonNumericTimestamp(t *testing.T) {
	t.Parallel()
	gw := newTestCashfreeGateway(t, "secret")
	body := []byte(`{}`)
	if err := gw.VerifyWebhookSignature(body, "not-a-number", "sig"); !errors.Is(err, ErrWebhookBadSignature) {
		t.Fatalf("expected ErrWebhookBadSignature for non-numeric ts, got %v", err)
	}
}

func TestVerifyWebhookSignature_UnconfiguredSecret(t *testing.T) {
	t.Parallel()
	gw := &CashfreeGateway{} // no secret
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	if err := gw.VerifyWebhookSignature([]byte("{}"), ts, "sig"); err == nil {
		t.Fatal("expected error when webhookSecret is unset, got nil")
	}
}

func TestVerifyWebhookSignature_TamperedBody(t *testing.T) {
	t.Parallel()
	gw := newTestCashfreeGateway(t, "secret")
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	body := []byte(`{"amount":100}`)
	sig := makeSig("secret", ts, body)

	// Attacker mutates the body but reuses the original signature.
	tampered := []byte(`{"amount":999}`)
	if err := gw.VerifyWebhookSignature(tampered, ts, sig); !errors.Is(err, ErrWebhookBadSignature) {
		t.Fatalf("expected ErrWebhookBadSignature for tampered body, got %v", err)
	}
}

// TestPaiseToRupees walks the canonical conversion endpoints. Cashfree
// expects the value as a JSON number with two-decimal precision; division
// by 100 is exact for integer paise.
func TestPaiseToRupees(t *testing.T) {
	t.Parallel()
	cases := []struct {
		paise int64
		want  float64
	}{
		{0, 0.0},
		{100, 1.0},
		{12345, 123.45},
		{500_000, 5000.0},
		{50_000_000, 500_000.0}, // ₹5L topup ceiling
	}
	for _, tc := range cases {
		got := paiseToRupees(tc.paise)
		if math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("paiseToRupees(%d) = %f, want %f", tc.paise, got, tc.want)
		}
	}
}

// TestRedactID covers the privacy guard for log lines.
func TestRedactID(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"short", "short"},
		{"12345678", "12345678"},
		{"123456789", "12345678…"},
		{"order_session_abcdefghij", "order_se…"},
	}
	for _, tc := range cases {
		if got := redactID(tc.in); got != tc.want {
			t.Errorf("redactID(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestExtractMethodKey verifies the wrapped payment_method shape Cashfree
// returns ({"upi":{...}}) is collapsed to the top-level key for our
// internal CFPayment.PaymentMethod field.
func TestExtractMethodKey(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw, want string
	}{
		{`{"upi":{"channel":"collect"}}`, "upi"},
		{`{"card":{"network":"VISA"}}`, "card"},
		{`null`, ""},
		{``, ""},
		{`"flat-string"`, ""},
	}
	for _, tc := range cases {
		got := extractMethodKey([]byte(tc.raw))
		if got != tc.want {
			t.Errorf("extractMethodKey(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}
