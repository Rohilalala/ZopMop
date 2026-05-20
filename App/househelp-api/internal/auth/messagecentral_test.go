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

func mcTestClient(t *testing.T, h http.Handler) *MessageCentralClient {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return NewMessageCentralClient(MessageCentralConfig{
		CustomerID: "cust1", AuthToken: "c2VjcmV0", BaseURL: srv.URL,
	})
}

func TestMC_TokenCachedAcrossSends(t *testing.T) {
	var tokenHits, sendHits int32
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/auth/v1/authentication/token"),
			r.URL.Path == "/auth/v1/authentication/token":
			atomic.AddInt32(&tokenHits, 1)
			w.Write([]byte(`{"token":"T1"}`))
		case r.URL.Path == "/verification/v3/send":
			atomic.AddInt32(&sendHits, 1)
			if r.Header.Get("authToken") != "T1" {
				t.Errorf("missing authToken header")
			}
			w.Write([]byte(`{"data":{"verificationId":"99"}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	for i := 0; i < 2; i++ {
		if _, err := c.SendOTP(context.Background(), "+919876543210"); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	if tokenHits != 1 {
		t.Fatalf("token fetched %d times, want 1 (cached)", tokenHits)
	}
	if sendHits != 2 {
		t.Fatalf("send hits = %d, want 2", sendHits)
	}
}

func TestMC_SendReturnsVerificationID(t *testing.T) {
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/verification/v3/send" {
			w.Write([]byte(`{"verificationId":"12345"}`))
			return
		}
		w.Write([]byte(`{"token":"T"}`))
	}))
	vid, err := c.SendOTP(context.Background(), "+919876543210")
	if err != nil || vid != "12345" {
		t.Fatalf("vid=%q err=%v, want 12345/nil", vid, err)
	}
}

func TestMC_VerifyHappyAndWrong(t *testing.T) {
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/verification/v3/validateOtp":
			if r.URL.Query().Get("code") == "111111" {
				w.Write([]byte(`{"data":{"verificationStatus":"VERIFICATION_COMPLETED"}}`))
			} else {
				w.Write([]byte(`{"data":{"verificationStatus":"VERIFICATION_FAILED"}}`))
			}
		default:
			w.Write([]byte(`{"token":"T"}`))
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

func TestMC_401RefetchesTokenOnceThenMisconfigured(t *testing.T) {
	var tokenHits, sendAttempts int32
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/verification/v3/send" {
			atomic.AddInt32(&sendAttempts, 1)
			w.WriteHeader(http.StatusUnauthorized) // always 401
			return
		}
		atomic.AddInt32(&tokenHits, 1)
		w.Write([]byte(`{"token":"T"}`))
	}))
	_, err := c.SendOTP(context.Background(), "+919876543210")
	if !errors.Is(err, ErrMCMisconfigured) {
		t.Fatalf("err=%v, want ErrMCMisconfigured", err)
	}
	if sendAttempts != 2 {
		t.Fatalf("send attempts = %d, want exactly 2 (orig + 1 retry)", sendAttempts)
	}
	if tokenHits != 2 {
		t.Fatalf("token fetched %d times, want 2 (initial + 1 refetch)", tokenHits)
	}
}

func TestMC_UnparseableBodyIsRejected(t *testing.T) {
	c := mcTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/verification/v3/send" {
			w.Write([]byte(`<html>not json</html>`))
			return
		}
		w.Write([]byte(`{"token":"T"}`))
	}))
	_, err := c.SendOTP(context.Background(), "+919876543210")
	if !errors.Is(err, ErrMCRejected) {
		t.Fatalf("err=%v, want ErrMCRejected (no silent default)", err)
	}
}
