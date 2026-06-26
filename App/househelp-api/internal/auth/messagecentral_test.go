package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// mcTestAuthToken is the canned dashboard token used by unit tests. The fix
// ships this value VERBATIM as the authToken header — no /auth/v1/.../token
// call happens, so we assert on it directly in handler-side checks.
const mcTestAuthToken = "dashboard-jwt-xyz"

func mcTestClient(t *testing.T, h http.Handler) *MessageCentralClient {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return NewMessageCentralClient(MessageCentralConfig{
		CustomerID: "cust1", AuthToken: mcTestAuthToken, BaseURL: srv.URL,
	})
}

// TestMC_SendSkipsTokenExchange proves the client sends `authToken: <cfg>`
// directly and NEVER calls /auth/v1/authentication/token, even across
// multiple sends.
func TestMC_SendSkipsTokenExchange(t *testing.T) {
	var sendHits int32
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/auth/v1/authentication/token") {
			t.Fatalf("client called token-exchange endpoint %s — must be skipped", r.URL.Path)
		}
		if r.URL.Path != "/verification/v3/send" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		atomic.AddInt32(&sendHits, 1)
		if got := r.Header.Get("authToken"); got != mcTestAuthToken {
			t.Errorf("authToken header = %q, want %q (config value sent verbatim)", got, mcTestAuthToken)
		}
		w.Write([]byte(`{"data":{"verificationId":"99"}}`))
	}))
	for i := range 2 {
		if _, err := c.SendOTP(context.Background(), "+919876543210"); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	if sendHits != 2 {
		t.Fatalf("send hits = %d, want 2", sendHits)
	}
}

func TestMC_SendReturnsVerificationID(t *testing.T) {
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/verification/v3/send" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Write([]byte(`{"verificationId":"12345"}`))
	}))
	vid, err := c.SendOTP(context.Background(), "+919876543210")
	if err != nil || vid != "12345" {
		t.Fatalf("vid=%q err=%v, want 12345/nil", vid, err)
	}
}

func TestMC_VerifyHappyAndWrong(t *testing.T) {
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/verification/v3/validateOtp" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if got := r.Header.Get("authToken"); got != mcTestAuthToken {
			t.Errorf("authToken header = %q, want %q", got, mcTestAuthToken)
		}
		if r.URL.Query().Get("code") == "111111" {
			w.Write([]byte(`{"data":{"verificationStatus":"VERIFICATION_COMPLETED"}}`))
		} else {
			w.Write([]byte(`{"data":{"verificationStatus":"VERIFICATION_FAILED"}}`))
		}
	}))
	if err := c.VerifyOTP(context.Background(), "99", "111111"); err != nil {
		t.Fatalf("happy verify: %v", err)
	}
	if err := c.VerifyOTP(context.Background(), "99", "000000"); !errors.Is(err, ErrOTPInvalid) {
		t.Fatalf("wrong code err=%v, want ErrOTPInvalid", err)
	}
}

func TestMC_DevModeBypass(t *testing.T) {
	c := NewMessageCentralClient(MessageCentralConfig{DevMode: true})
	vid, err := c.SendOTP(context.Background(), "+919876543210")
	if err != nil || !strings.HasPrefix(vid, "dev-") {
		t.Fatalf("dev send vid=%q err=%v", vid, err)
	}
	if err := c.VerifyOTP(context.Background(), vid, "999999"); err != nil {
		t.Fatalf("dev verify 999999: %v", err)
	}
	if err := c.VerifyOTP(context.Background(), vid, "123456"); !errors.Is(err, ErrOTPInvalid) {
		t.Fatalf("dev verify wrong: %v, want ErrOTPInvalid", err)
	}
}

// C10 defense-in-depth: even with DevMode=true, the hardcoded "999999" bypass
// must be disabled when IsProduction is set, so a misconfigured prod deploy
// cannot accept the dev OTP for any phone.
func TestMC_DevBypassDisabledInProduction(t *testing.T) {
	c := NewMessageCentralClient(MessageCentralConfig{DevMode: true, IsProduction: true})
	if c.DevMode() {
		t.Fatalf("DevMode() must report false when IsProduction is set")
	}
	if err := c.VerifyOTP(context.Background(), "dev-9999999999", "999999"); err == nil {
		t.Fatalf("VerifyOTP must NOT accept 999999 in production (got nil = accepted)")
	}
}

// TestMC_SendUnauthorizedMapsToMisconfigured locks in the new behaviour: a
// 401 from /verification/v3/send means the configured dashboard token is
// wrong/expired — no retry, no token refetch, surfaced as ErrMCMisconfigured
// so the handler can return 503 and the operator can rotate the env value.
func TestMC_SendUnauthorizedMapsToMisconfigured(t *testing.T) {
	var sendAttempts int32
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/auth/v1/authentication/token") {
			t.Fatalf("token-exchange must not be called; got %s", r.URL.Path)
		}
		if r.URL.Path != "/verification/v3/send" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		atomic.AddInt32(&sendAttempts, 1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	_, err := c.SendOTP(context.Background(), "+919876543210")
	if !errors.Is(err, ErrMCMisconfigured) {
		t.Fatalf("err=%v, want ErrMCMisconfigured", err)
	}
	if sendAttempts != 1 {
		t.Fatalf("send attempts = %d, want exactly 1 (no retry, nothing to refetch)", sendAttempts)
	}
}

// TestMC_VerifyUnauthorizedMapsToMisconfigured — same rule on the verify path.
func TestMC_VerifyUnauthorizedMapsToMisconfigured(t *testing.T) {
	var verifyAttempts int32
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/verification/v3/validateOtp" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		atomic.AddInt32(&verifyAttempts, 1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	err := c.VerifyOTP(context.Background(), "99", "111111")
	if !errors.Is(err, ErrMCMisconfigured) {
		t.Fatalf("err=%v, want ErrMCMisconfigured", err)
	}
	if verifyAttempts != 1 {
		t.Fatalf("verify attempts = %d, want exactly 1", verifyAttempts)
	}
}

func TestMC_UnparseableBodyIsRejected(t *testing.T) {
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/verification/v3/send" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Write([]byte(`<html>not json</html>`))
	}))
	_, err := c.SendOTP(context.Background(), "+919876543210")
	if !errors.Is(err, ErrMCRejected) {
		t.Fatalf("err=%v, want ErrMCRejected (no silent default)", err)
	}
}

// TestMC_MissingCredsMisconfigured guards the empty-config short-circuit on
// both calls — no HTTP attempt when CustomerID or AuthToken is blank.
func TestMC_MissingCredsMisconfigured(t *testing.T) {
	c := NewMessageCentralClient(MessageCentralConfig{CustomerID: "", AuthToken: ""})
	if _, err := c.SendOTP(context.Background(), "+919876543210"); !errors.Is(err, ErrMCMisconfigured) {
		t.Fatalf("send err=%v, want ErrMCMisconfigured", err)
	}
	if err := c.VerifyOTP(context.Background(), "99", "111111"); !errors.Is(err, ErrMCMisconfigured) {
		t.Fatalf("verify err=%v, want ErrMCMisconfigured", err)
	}
}
