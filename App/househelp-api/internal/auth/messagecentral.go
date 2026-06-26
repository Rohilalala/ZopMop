package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
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
// Auth: the value configured as MESSAGECENTRAL_AUTH_TOKEN (the "Auth Token"
// shown in the Message Central console) is a pre-issued long-lived session
// JWT. It is sent VERBATIM in the `authToken` header on every API call —
// there is no token-exchange step. The /auth/v1/authentication/token endpoint
// is NOT used (it 401s for these credentials; the dashboard token is the only
// usable bearer). If MC returns 401 on send/verify the configured token is
// wrong or expired and the operator must rotate MESSAGECENTRAL_AUTH_TOKEN.
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
	AuthToken  string // long-lived bearer copied from console.messagecentral.com → sent verbatim as `authToken` header
	BaseURL    string // defaults to mcDefaultBaseURL when empty
	DevMode    bool
	// IsProduction is a defense-in-depth latch (C10): even if DevMode is true,
	// the hardcoded "999999" bypass is disabled when this is set, so a
	// misconfigured prod deploy cannot accept the dev OTP. The config boot
	// guard is the primary protection; this is belt-and-braces.
	IsProduction bool
}

// MessageCentralClient talks to the VerifyNow API. Concurrent-safe (config is
// read-only after construction; *http.Client is itself concurrent-safe).
type MessageCentralClient struct {
	cfg     MessageCentralConfig
	http    *http.Client
	baseURL string
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

// devEnabled reports whether the dev short-circuit is active. It is forced
// off in production even if DevMode is set, so a misconfigured prod deploy
// cannot accept the hardcoded "999999" OTP (C10 defense-in-depth).
func (c *MessageCentralClient) devEnabled() bool { return c.cfg.DevMode && !c.cfg.IsProduction }

// DevMode reports whether OTP delivery is short-circuited.
func (c *MessageCentralClient) DevMode() bool { return c.devEnabled() }

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

// token returns the configured Auth Token verbatim. No HTTP call, no caching —
// the dashboard value is the bearer.
func (c *MessageCentralClient) token() (string, error) {
	if c.cfg.CustomerID == "" || c.cfg.AuthToken == "" {
		return "", ErrMCMisconfigured
	}
	return c.cfg.AuthToken, nil
}

// doAuthed performs an authed request. A 401 from Message Central is treated
// as misconfiguration (the dashboard token is wrong or expired); there is no
// retry because there is nothing to refetch.
func (c *MessageCentralClient) doAuthed(ctx context.Context, method, reqURL string) ([]byte, error) {
	tok, terr := c.token()
	if terr != nil {
		return nil, terr
	}
	req, rerr := http.NewRequestWithContext(ctx, method, reqURL, nil)
	if rerr != nil {
		return nil, fmt.Errorf("%w: build request: %v", ErrMCNetwork, rerr)
	}
	req.Header.Set("authToken", tok)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMCNetwork, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, ErrMCMisconfigured
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: HTTP %d", ErrMCRejected, resp.StatusCode)
	}
	return body, nil
}

// SendOTP triggers an OTP. Returns the verificationId the service must store.
func (c *MessageCentralClient) SendOTP(ctx context.Context, phone string) (string, error) {
	national := normalizeToNational10(phone)
	if c.devEnabled() {
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
			Str("body", truncateBody(string(body))).
			Msg("[mc] send response unparseable")
		return "", ErrMCRejected
	}
	// json.Number.String() returns "" for a missing field; "0" additionally catches an explicit verificationId:0.
	vid := env.VerificationID.String()
	if vid == "" || vid == "0" {
		vid = env.Data.VerificationID.String()
	}
	if vid == "" || vid == "0" {
		log.Warn().Str("phone_mask", logger.MaskPhone(phone)).
			Str("body", truncateBody(string(body))).
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
	if c.devEnabled() {
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
		// ASSUMPTION (docs unreachable): a non-2xx from validateOtp means the code did not match. A 5xx/429 would also surface here as ErrOTPInvalid — acceptable trade-off until the integration test confirms real error shapes.
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
			Str("body", truncateBody(string(body))).
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
	if c.devEnabled() {
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

// truncateBody caps a response body to 1KB for safe logging. It does NOT
// scrub credentials; Message Central does not echo our authToken in error
// bodies. A proper credential scrub is deferred (see docs/phase-12-backlog.md
// if that assumption ever proves false).
func truncateBody(body string) string {
	if len(body) > 1024 {
		return body[:1024]
	}
	return body
}
