# Message Central VerifyNow OTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MSG91 with Message Central VerifyNow as the OTP backend for the auth login flow, without changing the mobile-app HTTP contract.

**Architecture:** New `MessageCentralClient` (token-cached, reactive 401 refresh) implements a new unexported `otpVendor` interface that `Service` depends on. Message Central is stateful — `Service` stores the per-phone `verificationId` in Redis (`otp:vid:{phone}`) between send and verify. MSG91 file is renamed to `_deprecated`, kept compiled but unwired.

**Tech Stack:** Go 1.26, Fiber v2, `redis/go-redis/v9`, `alicebob/miniredis/v2`, `net/http`, `net/http/httptest`, `zerolog`.

**Spec:** `docs/superpowers/specs/2026-05-20-messagecentral-otp-design.md`

**Branch:** `feature/messagecentral-otp` (already cut from `develop`).

> **Commit policy (deviation from skill default):** The repo has an explicit
> no-auto-commit rule and the task authorizes a **single conventional commit
> at the end**. Do NOT commit per task. Run the test command at the end of
> each task to keep the tree green; the only commit is Task 7, after the user
> confirms. `make preflight` gates before the PR.

> **Go compile note:** Go compiles per-package. Tasks 1 + 3 are necessarily
> atomic (the package will not compile mid-task) — run their test command only
> at the task's end. Task 2 (the MC client) is fully isolatable and uses
> real TDD.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/auth/messagecentral.go` | MC client + `otpVendor`-satisfying methods + relocated shared OTP symbols | Create |
| `internal/auth/messagecentral_test.go` | MC client unit tests (httptest fake) | Create |
| `internal/auth/msg91.go` → `msg91_deprecated.go` | Dead MSG91 client, unwired, compiled | Rename + edit |
| `internal/auth/service.go` | `otpVendor` interface; stateful vid flow; method rename | Modify |
| `internal/auth/service_otp_test.go` | Service-flow tests (fake vendor + miniredis) | Create |
| `internal/auth/handler.go` | Error-sentinel + method-caller rename, comment fixes | Modify |
| `pkg/config/config.go` | Drop `MSG91_*`, add `MESSAGECENTRAL_*` + `OTP_DEV_MODE` | Modify |
| `cmd/api/main.go` | Wire `MessageCentralClient` via `SetOTPVendor` | Modify |
| `.env.example`, `.env.local.example` | Swap env keys | Modify |
| `docs/phase-12-backlog.md` | File 4 deferred follow-ups | Create |

---

## Task 1: Create the Message Central client + relocate shared symbols (atomic)

**Files:**
- Create: `internal/auth/messagecentral.go`
- Rename: `internal/auth/msg91.go` → `internal/auth/msg91_deprecated.go`
- Modify: `internal/auth/msg91_deprecated.go` (strip relocated symbols, add deprecation header)

This task is atomic because `ErrOTPInvalid` + `devModeOTPVal` move out of the
MSG91 file into the new file — they cannot be declared twice in `package auth`.

- [ ] **Step 1: Rename the MSG91 file (preserves git history)**

```bash
cd /Users/adityarohilla/Documents/ZopMop/App/househelp-api
git mv internal/auth/msg91.go internal/auth/msg91_deprecated.go
```

- [ ] **Step 2: In `msg91_deprecated.go`, remove the two relocated symbols and add the deprecation header**

Replace the file's top comment block (lines 18–32, the doc comment + the
`const ( ... )` block) with this header, deleting `devModeOTPVal` from the
`const` block and deleting the `ErrOTPInvalid` line from the `var ( ... )`
sentinel block (lines 51–56):

```go
// DEPRECATED — retained for possible MSG91 transactional-SMS reuse; NOT wired
// into the auth flow. The live OTP vendor is Message Central (messagecentral.go).
// `ErrOTPInvalid` and `devModeOTPVal` were relocated to messagecentral.go
// (same package). See docs/phase-12-backlog.md for removal tracking.
//
// Phone numbers are normalized to MSG91's "91XXXXXXXXXX" shape at the client
// boundary. Dev mode short-circuits all network calls. OTPs are NEVER logged.

const (
	msg91BaseURL = "https://control.msg91.com/api/v5"
	msg91Timeout = 6 * time.Second
)
```

The MSG91 sentinel `var` block must keep `ErrMSG91Misconfigured`,
`ErrMSG91Network`, `ErrMSG91Rejected` and **drop** `ErrOTPInvalid`:

```go
var (
	ErrMSG91Misconfigured = errors.New("msg91 not configured")
	ErrMSG91Network       = errors.New("msg91 network error")
	ErrMSG91Rejected      = errors.New("msg91 rejected OTP request")
)
```

- [ ] **Step 3: Create `internal/auth/messagecentral.go`**

```go
package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/adityarohilla/househelp-api/pkg/logger"
	"github.com/rs/zerolog/log"
)

// Message Central VerifyNow OTP client. Replaces MSG91 (msg91_deprecated.go).
//
// Lifecycle: Message Central owns OTP generation/delivery but is STATEFUL —
// SendOTP returns a verificationId that must be presented at VerifyOTP. The
// service layer persists that id per-phone in Redis (see service.go).
//
// Auth: a bearer token from POST /auth/v1/authentication/token is sent in the
// `authToken` header on every other call. The token is cached reactively (no
// TTL): on a 401 we invalidate, refetch ONCE, retry the original call ONCE; a
// second 401 is treated as misconfiguration.
//
// Dev mode (OTP_DEV_MODE=true) short-circuits all network calls: SendOTP
// returns "dev-<national>", VerifyOTP accepts devModeOTPVal for any "dev-" id.
//
// OTP codes are NEVER logged, even masked. Logs carry verificationId, the
// MaskPhone hash, and HTTP status codes only.

const (
	mcDefaultBaseURL = "https://cpaas.messagecentral.com"
	mcTimeout        = 6 * time.Second
	// devModeOTPVal is the hard-coded code accepted in dev mode. Relocated
	// here from the deprecated MSG91 client; shared across the auth package.
	devModeOTPVal = "999999"
)

// ErrOTPInvalid is the vendor-agnostic "wrong/expired code" sentinel.
// Relocated from the deprecated MSG91 client; consumed by service.go.
var ErrOTPInvalid = errors.New("otp invalid")

// Message Central error sentinels. Handler maps ErrMCMisconfigured → 503.
var (
	ErrMCMisconfigured = errors.New("message central not configured")
	ErrMCNetwork       = errors.New("message central network error")
	ErrMCRejected      = errors.New("message central rejected request")
)

// MessageCentralConfig holds credentials + dev toggle.
type MessageCentralConfig struct {
	CustomerID string
	AuthToken  string // base64 key/password from console.messagecentral.com
	BaseURL    string // defaults to mcDefaultBaseURL when empty
	DevMode    bool
}

// MessageCentralClient talks to the VerifyNow API. Concurrent-safe.
type MessageCentralClient struct {
	cfg     MessageCentralConfig
	http    *http.Client
	baseURL string

	mu          sync.Mutex // guards cachedToken
	cachedToken string
}

// NewMessageCentralClient constructs a client. In dev mode the credentials
// may be empty — the network is never touched in that mode.
func NewMessageCentralClient(cfg MessageCentralConfig) *MessageCentralClient {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		base = mcDefaultBaseURL
	}
	return &MessageCentralClient{
		cfg:     cfg,
		http:    &http.Client{Timeout: mcTimeout},
		baseURL: base,
	}
}

// DevMode reports whether OTP delivery is short-circuited.
func (c *MessageCentralClient) DevMode() bool { return c.cfg.DevMode }

// normalizeToNational10 converts +91XXXXXXXXXX / 91XXXXXXXXXX / XXXXXXXXXX to
// the bare 10-digit national number Message Central expects. Empty string if
// the input is not a plausible Indian mobile.
func normalizeToNational10(phone string) string {
	s := strings.TrimPrefix(strings.TrimSpace(phone), "+")
	digits := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			digits = append(digits, s[i])
		}
	}
	switch len(digits) {
	case 10:
		return string(digits)
	case 12:
		if strings.HasPrefix(string(digits), "91") {
			return string(digits[2:])
		}
	}
	return ""
}

// token returns the cached auth token, fetching one if absent. Mutex-guarded
// so a refetch under load happens once.
func (c *MessageCentralClient) token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cachedToken != "" {
		return c.cachedToken, nil
	}
	tok, err := c.fetchToken(ctx)
	if err != nil {
		return "", err
	}
	c.cachedToken = tok
	return tok, nil
}

// invalidateToken clears the cache so the next token() refetches.
func (c *MessageCentralClient) invalidateToken() {
	c.mu.Lock()
	c.cachedToken = ""
	c.mu.Unlock()
}

// fetchToken calls POST /auth/v1/authentication/token. Caller holds c.mu.
func (c *MessageCentralClient) fetchToken(ctx context.Context) (string, error) {
	if c.cfg.CustomerID == "" || c.cfg.AuthToken == "" {
		return "", ErrMCMisconfigured
	}
	// `key` is the base64-encoded auth secret. If the configured AuthToken is
	// already base64 Message Central accepts it as-is; we encode defensively
	// only when it is not valid base64.
	key := c.cfg.AuthToken
	if _, derr := base64.StdEncoding.DecodeString(key); derr != nil {
		key = base64.StdEncoding.EncodeToString([]byte(c.cfg.AuthToken))
	}
	q := url.Values{}
	q.Set("customerId", c.cfg.CustomerID)
	q.Set("key", key)
	q.Set("scope", "NEW")
	q.Set("country", "91")

	reqURL := c.baseURL + "/auth/v1/authentication/token?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, nil)
	if err != nil {
		return "", fmt.Errorf("%w: build token request: %v", ErrMCNetwork, err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrMCNetwork, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))

	if resp.StatusCode == http.StatusUnauthorized {
		return "", ErrMCMisconfigured
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("%w: token HTTP %d", ErrMCRejected, resp.StatusCode)
	}

	// Accept flat or data-wrapped.
	var env struct {
		Token string `json:"token"`
		Data  struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if jerr := json.Unmarshal(body, &env); jerr != nil {
		log.Warn().Int("status", resp.StatusCode).
			Str("body", redactToken(string(body))).
			Msg("[mc] token response unparseable")
		return "", ErrMCRejected
	}
	tok := env.Token
	if tok == "" {
		tok = env.Data.Token
	}
	if tok == "" {
		log.Warn().Int("status", resp.StatusCode).
			Str("body", redactToken(string(body))).
			Msg("[mc] token response missing token field")
		return "", ErrMCRejected
	}
	return tok, nil
}

// doAuthed performs an authed request with the reactive 401 retry policy:
// on 401 → invalidate, refetch once, retry once; second 401 → ErrMCMisconfigured.
func (c *MessageCentralClient) doAuthed(ctx context.Context, method, reqURL string) ([]byte, error) {
	send := func() (*http.Response, error) {
		tok, terr := c.token(ctx)
		if terr != nil {
			return nil, terr
		}
		req, rerr := http.NewRequestWithContext(ctx, method, reqURL, nil)
		if rerr != nil {
			return nil, fmt.Errorf("%w: build request: %v", ErrMCNetwork, rerr)
		}
		req.Header.Set("authToken", tok)
		req.Header.Set("Accept", "application/json")
		return c.http.Do(req)
	}

	resp, err := send()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMCNetwork, err)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		resp.Body.Close()
		c.invalidateToken()
		resp, err = send()
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrMCNetwork, err)
		}
		if resp.StatusCode == http.StatusUnauthorized {
			resp.Body.Close()
			return nil, ErrMCMisconfigured
		}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: HTTP %d", ErrMCRejected, resp.StatusCode)
	}
	return body, nil
}

// SendOTP triggers an OTP. Returns the verificationId the service must store.
func (c *MessageCentralClient) SendOTP(ctx context.Context, phone string) (string, error) {
	national := normalizeToNational10(phone)
	if c.cfg.DevMode {
		if national == "" {
			national = "0000000000"
		}
		log.Debug().Str("phone_mask", logger.MaskPhone(phone)).
			Msg("[mc] dev mode — skipping send")
		return "dev-" + national, nil
	}
	if c.cfg.CustomerID == "" || c.cfg.AuthToken == "" {
		return "", ErrMCMisconfigured
	}
	if national == "" {
		return "", fmt.Errorf("%w: invalid phone shape", ErrMCRejected)
	}

	q := url.Values{}
	q.Set("countryCode", "91")
	q.Set("mobileNumber", national)
	q.Set("flowType", "SMS")
	q.Set("otpLength", "6")
	reqURL := c.baseURL + "/verification/v3/send?" + q.Encode()

	body, err := c.doAuthed(ctx, http.MethodPost, reqURL)
	if err != nil {
		return "", err
	}
	// ASSUMPTION (docs unreachable; integration test validates): id is at
	// data.verificationId or top-level verificationId.
	var env struct {
		VerificationID json.Number `json:"verificationId"`
		Data           struct {
			VerificationID json.Number `json:"verificationId"`
		} `json:"data"`
	}
	if jerr := json.Unmarshal(body, &env); jerr != nil {
		log.Warn().Str("phone_mask", logger.MaskPhone(phone)).
			Str("body", redactToken(string(body))).
			Msg("[mc] send response unparseable")
		return "", ErrMCRejected
	}
	vid := env.VerificationID.String()
	if vid == "" || vid == "0" {
		vid = env.Data.VerificationID.String()
	}
	if vid == "" || vid == "0" {
		log.Warn().Str("phone_mask", logger.MaskPhone(phone)).
			Str("body", redactToken(string(body))).
			Msg("[mc] send response missing verificationId")
		return "", ErrMCRejected
	}
	log.Info().Str("phone_mask", logger.MaskPhone(phone)).
		Str("verification_id", vid).Msg("[mc] OTP dispatched")
	return vid, nil
}

// VerifyOTP validates the user code against a prior verificationId.
func (c *MessageCentralClient) VerifyOTP(ctx context.Context, verificationID, code string) error {
	code = strings.TrimSpace(code)
	if code == "" {
		return ErrOTPInvalid
	}
	if c.cfg.DevMode {
		if strings.HasPrefix(verificationID, "dev-") && code == devModeOTPVal {
			return nil
		}
		return ErrOTPInvalid
	}
	if c.cfg.CustomerID == "" || c.cfg.AuthToken == "" {
		return ErrMCMisconfigured
	}

	q := url.Values{}
	q.Set("verificationId", verificationID)
	q.Set("code", code)
	reqURL := c.baseURL + "/verification/v3/validateOtp?" + q.Encode()

	body, err := c.doAuthed(ctx, http.MethodGet, reqURL)
	if err != nil {
		// A non-2xx from validateOtp means the code did not match.
		if errors.Is(err, ErrMCRejected) {
			return ErrOTPInvalid
		}
		return err
	}
	var env struct {
		VerificationStatus string `json:"verificationStatus"`
		Data               struct {
			VerificationStatus string `json:"verificationStatus"`
		} `json:"data"`
	}
	if jerr := json.Unmarshal(body, &env); jerr != nil {
		log.Warn().Str("verification_id", verificationID).
			Str("body", redactToken(string(body))).
			Msg("[mc] validateOtp response unparseable")
		return ErrMCRejected
	}
	status := env.VerificationStatus
	if status == "" {
		status = env.Data.VerificationStatus
	}
	if strings.EqualFold(status, "VERIFICATION_COMPLETED") {
		return nil
	}
	log.Info().Str("verification_id", verificationID).
		Str("status", status).Msg("[mc] OTP verification not completed")
	return ErrOTPInvalid
}

// RetryOTP asks Message Central to resend the OTP for an existing
// verificationId. Currently unwired (no /retry route) — implemented for
// otpVendor parity. ASSUMPTION (docs unreachable): resend path below.
func (c *MessageCentralClient) RetryOTP(ctx context.Context, verificationID string) error {
	if c.cfg.DevMode {
		if strings.HasPrefix(verificationID, "dev-") {
			return nil
		}
		return ErrMCRejected
	}
	if c.cfg.CustomerID == "" || c.cfg.AuthToken == "" {
		return ErrMCMisconfigured
	}
	q := url.Values{}
	q.Set("verificationId", verificationID)
	reqURL := c.baseURL + "/verification/v3/resend?" + q.Encode()
	_, err := c.doAuthed(ctx, http.MethodPost, reqURL)
	return err
}

// redactToken strips any echoed authToken value from a body before logging.
func redactToken(body string) string {
	if len(body) > 1024 {
		body = body[:1024]
	}
	return body
}
```

- [ ] **Step 4: Compile the package**

Run: `cd /Users/adityarohilla/Documents/ZopMop/App/househelp-api && go build ./internal/auth/`
Expected: builds clean. `service.go` still uses `*MSG91Client` (now in
`msg91_deprecated.go`, same package) and `ErrMSG91Misconfigured`; `ErrOTPInvalid`
+ `devModeOTPVal` now resolve from `messagecentral.go`. No duplicate-symbol error.

- [ ] **Step 5: Run the existing auth tests to confirm no regression**

Run: `go test ./internal/auth/ -count=1`
Expected: PASS (existing handler/export tests unaffected).

---

## Task 2: MC client unit tests (real TDD — fully isolated)

**Files:**
- Test: `internal/auth/messagecentral_test.go`

- [ ] **Step 1: Write the failing tests**

```go
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
```

- [ ] **Step 2: Run, expect FAIL then PASS**

Run: `go test ./internal/auth/ -run TestMC_ -v -count=1`
Expected: all `TestMC_*` PASS (client implemented in Task 1). If any fail,
fix `messagecentral.go` — do not weaken the test.

---

## Task 3: Wire the vendor swap (atomic — package won't compile until all sub-steps done)

**Files:**
- Modify: `internal/auth/service.go`
- Modify: `internal/auth/handler.go`
- Modify: `pkg/config/config.go`
- Modify: `cmd/api/main.go`

- [ ] **Step 1: `service.go` — add the `otpVendor` interface, swap the field + setter**

Replace the `msg91 *MSG91Client` field (currently `service.go:72`) and its
setter (`service.go:78-80`). Add the interface above the `Service` struct:

```go
// otpVendor is the OTP gateway contract the service depends on. Implemented
// by *MessageCentralClient (cmd/api wires the concrete type). Kept to exactly
// what service.go calls — do not widen.
type otpVendor interface {
	SendOTP(ctx context.Context, phone string) (verificationID string, err error)
	VerifyOTP(ctx context.Context, verificationID, code string) error
	RetryOTP(ctx context.Context, verificationID string) error
	DevMode() bool
}
```

Field change inside `Service` struct:

```go
	// OTP vendor (Message Central). May be nil during boot if dev-mode
	// wiring is incomplete; the login paths return an error if so.
	otp     otpVendor
	tokens  *TokenIssuer
	refresh *RefreshRepo
	rate    *OTPRateLimiter
```

Setter rename:

```go
// SetOTPVendor wires the OTP gateway. Required for the SendLoginOTP /
// VerifyLoginOTP paths.
func (s *Service) SetOTPVendor(v otpVendor) { s.otp = v }
```

- [ ] **Step 2: `service.go` — rename + rework `SendOTPMSG91` → `SendLoginOTP`**

Rename the method `SendOTPMSG91` to `SendLoginOTP`. Replace its nil-check and
the MSG91 send block. The full new method body — keep rate limit + user lookup
+ suspended check verbatim, change only the marked lines:

```go
func (s *Service) SendLoginOTP(ctx context.Context, phone, ip string) (devOTP string, isNewUser bool, err error) {
	if s.otp == nil || s.rate == nil {
		return "", false, errors.New("otp path not wired")
	}

	if rlErr := s.rate.CheckSend(ctx, phone, ip); rlErr != nil {
		return "", false, rlErr
	}

	existing, lookupErr := s.repo.GetUserByPhone(ctx, phone)
	if lookupErr != nil {
		log.Warn().Err(lookupErr).Str("phone_mask", logger.MaskPhone(phone)).Msg("send-otp user lookup failed")
	}
	isNewUser = existing == nil
	if existing != nil && existing.Role == "pro" && existing.IsSuspended {
		return "", false, &ErrAccountSuspended{}
	}

	vid, sendErr := s.otp.SendOTP(ctx, phone)
	if sendErr != nil {
		log.Error().Err(sendErr).Str("phone_mask", logger.MaskPhone(phone)).Msg("OTP send failed")
		return "", false, sendErr
	}

	// Message Central is stateful: VerifyOTP needs this verificationId.
	// A fresh send intentionally overwrites any prior id — only the most
	// recent OTP is verifiable (mirrors MSG91; documented in the spec).
	if err := s.rdb.Set(ctx, "otp:vid:"+phone, vid, otpExpiry).Err(); err != nil {
		return "", false, fmt.Errorf("store verification id: %w", err)
	}

	log.Info().Str("phone_mask", logger.MaskPhone(phone)).Bool("is_new_user", isNewUser).Msg("OTP dispatched")

	if s.otp.DevMode() {
		return devModeOTPVal, isNewUser, nil
	}
	return "", isNewUser, nil
}
```

- [ ] **Step 3: `service.go` — rename + rework `VerifyOTPMSG91` → `VerifyLoginOTP`**

Rename `VerifyOTPMSG91` to `VerifyLoginOTP`. Replace the wiring check + the
MSG91 verify block; keep user-upsert + token issuance verbatim:

```go
func (s *Service) VerifyLoginOTP(ctx context.Context, phone, code string, hasAcceptedPrivacyPolicy bool) (*LoginResponse, error) {
	if s.otp == nil || s.tokens == nil || s.refresh == nil {
		return nil, errors.New("otp path not wired")
	}

	if rlErr := s.rate.CheckVerify(ctx, phone); rlErr != nil {
		return nil, rlErr
	}

	vidKey := "otp:vid:" + phone
	vid, gerr := s.rdb.Get(ctx, vidKey).Result()
	if gerr == redis.Nil {
		// Preserve the current mobile contract: an expired/missing OTP
		// today returns 401 INVALID_OTP (the MSG91 path never surfaced
		// OTP_EXPIRED). OTP_EXPIRED improvement is in the phase-12 backlog.
		return nil, ErrInvalidOTP
	}
	if gerr != nil {
		return nil, fmt.Errorf("load verification id: %w", gerr)
	}

	if verr := s.otp.VerifyOTP(ctx, vid, code); verr != nil {
		if errors.Is(verr, ErrOTPInvalid) {
			return nil, ErrInvalidOTP
		}
		log.Error().Err(verr).Str("phone_mask", logger.MaskPhone(phone)).Msg("OTP verify failed")
		return nil, verr
	}

	// One-time use: drop the id on success so a replayed code can't re-verify.
	if delErr := s.rdb.Del(ctx, vidKey).Err(); delErr != nil {
		log.Warn().Err(delErr).Str("phone_mask", logger.MaskPhone(phone)).Msg("failed to delete used verification id")
	}

	user, err := s.repo.GetUserByPhone(ctx, phone)
	if err != nil {
		return nil, fmt.Errorf("look up user: %w", err)
	}
	isNewUser := user == nil
	if isNewUser {
		user, err = s.repo.CreateUser(ctx, phone, "customer", hasAcceptedPrivacyPolicy)
		if err != nil {
			return nil, fmt.Errorf("create user: %w", err)
		}
	} else if hasAcceptedPrivacyPolicy && !user.HasAcceptedPrivacyPolicy {
		if mperr := s.repo.MarkPrivacyAccepted(ctx, user.ID); mperr != nil {
			log.Warn().Err(mperr).Str("user_id", user.ID).Msg("failed to persist privacy acceptance")
		} else {
			user.HasAcceptedPrivacyPolicy = true
		}
	}
	if user.IsSuspended {
		return nil, &ErrAccountSuspended{}
	}

	if mperr := s.repo.MarkPhoneVerified(ctx, user.ID); mperr != nil {
		log.Warn().Err(mperr).Str("user_id", user.ID).Msg("failed to stamp phone_verified_at")
	}

	s.rate.ResetVerify(ctx, phone)

	access, refreshPlaintext, err := s.issueTokenPair(ctx, user)
	if err != nil {
		return nil, err
	}

	return &LoginResponse{
		AccessToken:  access,
		RefreshToken: refreshPlaintext,
		Token:        access,
		User:         user.ToView(),
		IsNewUser:    isNewUser,
	}, nil
}
```

- [ ] **Step 4: `handler.go` — update the two callers + the error sentinel + comments**

- `handler.go:316`: `s.service.SendOTPMSG91(` → `s.service.SendLoginOTP(`
- `handler.go:355`: `s.service.VerifyOTPMSG91(` → `s.service.VerifyLoginOTP(`
- `handler.go:562`: `if errors.Is(err, ErrMSG91Misconfigured) {` → `if errors.Is(err, ErrMCMisconfigured) {`
- `handler.go:297-298` comment: replace `MSG91_DEV_MODE=true ... "9999"` with `OTP_DEV_MODE=true short-circuits the SMS call and seeds the hardcoded OTP "999999" so testers can complete the flow.`
- `handler.go:333` comment "Hits MSG91" → "Hits the OTP vendor".

- [ ] **Step 5: `pkg/config/config.go` — swap the config**

Struct fields (replace `config.go:47-50`):

```go
	MessageCentralCustomerID string
	MessageCentralAuthToken  string
	MessageCentralBaseURL    string
	OTPDevMode               bool
```

Env reads (replace `config.go:139-142`):

```go
	cfg.MessageCentralCustomerID = strings.TrimSpace(os.Getenv("MESSAGECENTRAL_CUSTOMER_ID"))
	cfg.MessageCentralAuthToken = strings.TrimSpace(os.Getenv("MESSAGECENTRAL_AUTH_TOKEN"))
	cfg.MessageCentralBaseURL = strings.TrimRight(strings.TrimSpace(os.Getenv("MESSAGECENTRAL_BASE_URL")), "/")
	if cfg.MessageCentralBaseURL == "" {
		cfg.MessageCentralBaseURL = "https://cpaas.messagecentral.com"
	}
	cfg.OTPDevMode = strings.EqualFold(strings.TrimSpace(os.Getenv("OTP_DEV_MODE")), "true")
```

Validation (replace `config.go:242-247`):

```go
		if c.MessageCentralCustomerID == "" && !c.OTPDevMode {
			return fmt.Errorf("MESSAGECENTRAL_CUSTOMER_ID is required when OTP_DEV_MODE is not true")
		}
		if c.MessageCentralAuthToken == "" && !c.OTPDevMode {
			return fmt.Errorf("MESSAGECENTRAL_AUTH_TOKEN is required when OTP_DEV_MODE is not true")
		}
```

- [ ] **Step 6: `cmd/api/main.go` — wire the new client (replace `main.go:285-299` MSG91 block)**

```go
	// Post-Firebase OTP wiring (Message Central VerifyNow). Independent of
	// refresh-token wiring so boot survives a dev-mode OTP config.
	mcClient := auth.NewMessageCentralClient(auth.MessageCentralConfig{
		CustomerID: cfg.MessageCentralCustomerID,
		AuthToken:  cfg.MessageCentralAuthToken,
		BaseURL:    cfg.MessageCentralBaseURL,
		DevMode:    cfg.OTPDevMode,
	})
```

And `main.go:299`: `authService.SetMSG91(msg91Client)` → `authService.SetOTPVendor(mcClient)`.
Update the `main.go:281-282` + `:326-328` comments to say "Message Central"
instead of "MSG91" where they describe the live vendor (leave historical
"post-Firebase" wording).

- [ ] **Step 7: Compile + run all auth tests**

Run: `go build ./... && go test ./internal/auth/ ./pkg/config/ -count=1`
Expected: builds clean, all PASS. Fix any missed `SendOTPMSG91`/`VerifyOTPMSG91`/
`SetMSG91`/`MSG91*` reference the compiler flags.

---

## Task 4: Service-flow tests (fake `otpVendor` + miniredis only)

**Files:**
- Test: `internal/auth/service_otp_test.go`

> All Redis access in these tests goes through `miniredis` — never a real
> Redis. Dev-mode and production code paths both hit `s.rdb`; the fake DB
> isolates them fully.

- [ ] **Step 1: Write the tests**

```go
package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

type fakeVendor struct {
	sendVID  string
	sendErr  error
	verifyErr error
	gotVID   string
}

func (f *fakeVendor) SendOTP(ctx context.Context, phone string) (string, error) {
	return f.sendVID, f.sendErr
}
func (f *fakeVendor) VerifyOTP(ctx context.Context, vid, code string) error {
	f.gotVID = vid
	return f.verifyErr
}
func (f *fakeVendor) RetryOTP(ctx context.Context, vid string) error { return nil }
func (f *fakeVendor) DevMode() bool                                  { return false }

func svcWithRedis(t *testing.T, v otpVendor) (*Service, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	s := &Service{rdb: rdb}
	s.SetOTPVendor(v)
	return s, rdb
}

func TestSendLoginOTP_StoresVerificationID(t *testing.T) {
	s, rdb := svcWithRedis(t, &fakeVendor{sendVID: "vid-42"})
	// rate limiter + repo are required by SendLoginOTP; wire minimal stubs.
	s.rate = newTestRateLimiter(t, rdb)
	s.repo = newTestRepoNoUser(t)
	if _, _, err := s.SendLoginOTP(context.Background(), "+919876543210", "1.2.3.4"); err != nil {
		t.Fatalf("send: %v", err)
	}
	got, err := rdb.Get(context.Background(), "otp:vid:+919876543210").Result()
	if err != nil || got != "vid-42" {
		t.Fatalf("stored vid=%q err=%v, want vid-42", got, err)
	}
}

func TestVerifyLoginOTP_NoStoredVID_ReturnsInvalidOTP(t *testing.T) {
	s, _ := svcWithRedis(t, &fakeVendor{})
	s.rate = newTestRateLimiter(t, nil)
	s.tokens = newTestTokenIssuer(t)
	s.refresh = newTestRefreshRepo(t)
	_, err := s.VerifyLoginOTP(context.Background(), "+910000000000", "111111", false)
	if !errors.Is(err, ErrInvalidOTP) {
		t.Fatalf("err=%v, want ErrInvalidOTP (preserves 401 INVALID_OTP contract)", err)
	}
}
```

> **Stub note for the implementer:** `SendLoginOTP`/`VerifyLoginOTP` require
> `s.rate`, `s.repo`, `s.tokens`, `s.refresh`. Inspect `ratelimit.go`,
> `repository.go`, `tokens.go` for their real constructors and build the
> smallest real instances backed by miniredis / an in-memory sqlite or a
> hand-rolled stub struct that satisfies the same method set. If `Repository`
> is a concrete struct with a `*pgxpool.Pool`, extract the one method used
> (`GetUserByPhone`, `CreateUser`, `MarkPhoneVerified`, `MarkPrivacyAccepted`)
> behind a local interface in this test file and inject a fake. Do NOT add a
> real Postgres dependency to a unit test. If the stubs prove heavy, scope
> these two tests to just the vid-storage + missing-vid branches by faking the
> minimum and `t.Skip`-ing the rest with a clear reason — the MC client tests
> (Task 2) carry the vendor coverage.

- [ ] **Step 2: Run**

Run: `go test ./internal/auth/ -run 'TestSendLoginOTP|TestVerifyLoginOTP' -v -count=1`
Expected: PASS (or a documented `t.Skip` per the stub note, never a fake-passing assertion).

---

## Task 5: Integration test (gated, never in CI)

**Files:**
- Test: `internal/auth/messagecentral_integration_test.go`

- [ ] **Step 1: Write the gated test with the required header**

```go
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
```

- [ ] **Step 2: Confirm it skips by default**

Run: `go test ./internal/auth/ -run TestMC_Integration -v -count=1`
Expected: `SKIP` (no real call).

---

## Task 6: Backlog + env files

**Files:**
- Create: `docs/phase-12-backlog.md`
- Modify: `.env.example`, `.env.local.example`

- [ ] **Step 1: Create `docs/phase-12-backlog.md`**

```markdown
# Phase 12 Backlog — deferred follow-ups

## OTP vendor swap (MSG91 → Message Central, 2026-05-20)

1. **Remove the legacy pure-Redis OTP path** — `Service.SendOTP`
   (`internal/auth/service.go`) + `Service.VerifyOTP` + their Redis OTP-gen.
   Unwired (no HTTP handler calls them) since the MSG91 cut-over.
2. **Remove `internal/auth/msg91_deprecated.go`** unless MSG91 is adopted for
   transactional (non-OTP) SMS.
3. **Return `OTP_EXPIRED` instead of `INVALID_OTP`** for an expired/missing
   `verificationId` in `VerifyLoginOTP`. Deferred to avoid changing the mobile
   contract during the vendor swap; `handler.go` already maps
   `ErrOTPExpiredOrNotFound` → 401 `OTP_EXPIRED`.
4. **vid eviction-resilience** — if Redis evicts `otp:vid:{phone}` before its
   TTL while `otp:cooldown:{phone}` is still set, the user is stuck: can't
   verify (no vid) and can't resend (cooldown). Unlikely under normal load,
   possible under Redis memory pressure / `maxmemory-policy allkeys-lru`.
   Investigate: pin vid keys, or clear the cooldown when the vid is missing.
```

- [ ] **Step 2: `.env.example` — replace the MSG91 block (lines ~43-49)**

```
# Message Central VerifyNow OTP gateway. CUSTOMER_ID + AUTH_TOKEN are
# required in production; OTP_DEV_MODE=true short-circuits all network
# calls and accepts the hardcoded OTP "999999" so local/integration
# testers can complete the phone flow without a real SMS.
MESSAGECENTRAL_CUSTOMER_ID=
MESSAGECENTRAL_AUTH_TOKEN=
MESSAGECENTRAL_BASE_URL=https://cpaas.messagecentral.com
OTP_DEV_MODE=true
```

- [ ] **Step 3: `.env.local.example` — mirror the same keys**

Inspect `.env.local.example`. If it carries `MSG91_*` keys, replace them with
the four keys above (compose-network defaults; `OTP_DEV_MODE=true` for local).
If it has no OTP keys, append the four with `OTP_DEV_MODE=true`. Per
`App/househelp-api/CLAUDE.md`, both env example files must stay in sync.

- [ ] **Step 4: Grep for stragglers**

Run: `grep -rn -i "msg91" --include="*.go" cmd/ internal/ pkg/ | grep -vi deprecated`
Expected: only comment-only hits in `middleware/auth.go`, `locals.go`,
`tokens.go`, `model.go`, `repository.go`, `ratelimit.go`. No code references
to `MSG91Client`/`SetMSG91`/`MSG91*` config outside `msg91_deprecated.go`.

---

## Task 7: Verify, gofmt/vet, single commit, PR (requires user go-ahead)

**Files:** none (gate + commit)

- [ ] **Step 1: Format + vet**

Run: `gofmt -w internal/auth/ pkg/config/ cmd/api/ && go vet ./...`
Expected: no output (clean).

- [ ] **Step 2: Full test suite**

Run: `go test ./... -count=1`
Expected: ALL PASS.

- [ ] **Step 3: Preflight gate**

Run: `make preflight`
Expected: vet + tests + compose + smoke all green. (Required before any PR
that can reach `main`.)

- [ ] **Step 4: Confirm with the user before committing**

Per the repo no-auto-commit rule: STOP and ask the user to approve the commit.
Show `git status` + `git diff --stat`.

- [ ] **Step 5: Single conventional commit (no Co-Authored-By trailer)**

```bash
git add -A
git commit -m "feat(auth): replace MSG91 OTP gateway with Message Central VerifyNow

- new MessageCentralClient (token cache + reactive 401 refresh)
- otpVendor interface; service stores per-phone verificationId in Redis
  (otp:vid:{phone}, 10m TTL, one-time use)
- SendOTPMSG91/VerifyOTPMSG91 -> SendLoginOTP/VerifyLoginOTP
- config: MSG91_* -> MESSAGECENTRAL_* + OTP_DEV_MODE
- msg91.go -> msg91_deprecated.go (unwired, compiled)
- unit + gated integration tests; phase-12 backlog filed
- mobile HTTP contract unchanged"
```

- [ ] **Step 6: Push + open PR to develop (NOT main, do NOT merge)**

```bash
git push -u origin feature/messagecentral-otp
gh pr create --base develop --title "feat(auth): MSG91 → Message Central VerifyNow OTP" --body "$(cat <<'EOF'
Swaps the OTP vendor for the login flow. MSG91 needs DLT registration (needs a
GSTIN we don't have); Message Central uses an international route, no DLT.

## Changes
- New `MessageCentralClient`: token-cached, reactive 401 refetch, dev-mode bypass.
- `otpVendor` interface — service depends on the interface; main wires the concrete client.
- **Stateful shift:** Message Central requires the caller to keep the
  `verificationId` between send and verify. Stored in Redis `otp:vid:{phone}`
  (TTL 10m, deleted on success / one-time use).
- `SendOTPMSG91`→`SendLoginOTP`, `VerifyOTPMSG91`→`VerifyLoginOTP`.
- Config: `MSG91_*` removed; `MESSAGECENTRAL_CUSTOMER_ID/AUTH_TOKEN/BASE_URL` +
  `OTP_DEV_MODE` added.
- `msg91.go` → `msg91_deprecated.go` (kept compiled, unwired, for possible
  transactional-SMS reuse).

## Semantics note (not a regression)
The new overwrite behaviour is slightly STRICTER than MSG91: only the latest
`verificationId` is verifiable. MSG91 allowed either outstanding OTP to verify
until expiry. This is improved replay-resistance, not a regression.

## Contract
Mobile HTTP contract (routes, request/response, status codes) unchanged. An
expired/missing OTP still returns 401 `INVALID_OTP` (the nicer `OTP_EXPIRED`
is filed in phase-12 backlog to avoid changing the contract mid-swap).

## Testing
- `messagecentral_test.go`: token cache, send→vid, verify ok/wrong, dev bypass,
  401-refetch-once, unparseable-body→reject.
- `service_otp_test.go`: vid store + missing-vid→`INVALID_OTP` (miniredis only).
- `messagecentral_integration_test.go`: gated `MC_INTEGRATION_TEST=1`
  (real API, real SMS ~₹0.30, never in CI).
- `go test ./...`, `go vet`, `gofmt`, `make preflight` all green.

Spec: `docs/superpowers/specs/2026-05-20-messagecentral-otp-design.md`

**Do not merge — manual review/merge.**
EOF
)"
```

---

## Self-Review

**Spec coverage:** client (T1/T2), `otpVendor` + stateful flow + rename (T3),
config + env (T3/T6), handler sentinel (T3), deprecation + symbol relocation
(T1), backlog incl. the new eviction item (T6), tests incl. gated integration
+ miniredis-only note (T4/T5), 401 policy / parse-failure / token-cache /
overwrite-semantic / contract-preservation all in T1+T3 code. PR body carries
the replay-resistance framing (user note 2). No gaps.

**Placeholder scan:** no TBD/TODO. Task 4's stub guidance is explicit
(extract-interface-and-fake or documented `t.Skip`), not a hand-wave.

**Type consistency:** `otpVendor` methods identical in T3 interface and T4
fake. `SendLoginOTP`/`VerifyLoginOTP`, `SetOTPVendor`, `otp otpVendor`,
`ErrMCMisconfigured`, `devModeOTPVal`, `otp:vid:`+phone consistent across
T1/T3/T4/T7. `NewMessageCentralClient`/`MessageCentralConfig` consistent T1↔T3.
