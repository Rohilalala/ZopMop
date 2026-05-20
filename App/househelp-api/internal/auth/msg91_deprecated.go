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

// MSG91Config holds the gateway credentials + dev-mode toggle.
type MSG91Config struct {
	AuthKey    string
	TemplateID string
	SenderID   string
	DevMode    bool
}

// MSG91Client talks to the MSG91 OTP API. Use NewMSG91Client to
// construct one. Concurrent-safe — uses a stdlib http.Client.
type MSG91Client struct {
	cfg     MSG91Config
	http    *http.Client
	baseURL string
}

// MSG91 error sentinels. Handler maps these to HTTP status codes.
var (
	ErrMSG91Misconfigured = errors.New("msg91 not configured")
	ErrMSG91Network       = errors.New("msg91 network error")
	ErrMSG91Rejected      = errors.New("msg91 rejected OTP request")
)

// NewMSG91Client constructs a client. In dev mode AuthKey/TemplateID
// can be empty — the client never touches the network in that mode.
func NewMSG91Client(cfg MSG91Config) *MSG91Client {
	return &MSG91Client{
		cfg:     cfg,
		http:    &http.Client{Timeout: msg91Timeout},
		baseURL: msg91BaseURL,
	}
}

// DevMode reports whether this client short-circuits OTP delivery.
// The handler uses this to decide whether to surface a "dev OTP" hint
// in the send-otp response.
func (c *MSG91Client) DevMode() bool { return c.cfg.DevMode }

// normalize converts +91XXXXXXXXXX or 91XXXXXXXXXX or XXXXXXXXXX (10
// digits) to the "91XXXXXXXXXX" shape MSG91 expects. Returns an empty
// string if the input doesn't look like an Indian mobile.
func normalizeForMSG91(phone string) string {
	s := strings.TrimSpace(phone)
	s = strings.TrimPrefix(s, "+")
	digits := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			digits = append(digits, s[i])
		}
	}
	switch len(digits) {
	case 10:
		return "91" + string(digits)
	case 12:
		if strings.HasPrefix(string(digits), "91") {
			return string(digits)
		}
	}
	return ""
}

// SendOTP triggers an OTP for the given phone. In dev mode it returns
// nil without making a network call. In live mode it POSTs to
// /api/v5/otp with authkey/template_id/mobile as query params per
// MSG91 docs.
func (c *MSG91Client) SendOTP(ctx context.Context, phone string) error {
	if c.cfg.DevMode {
		log.Debug().Str("phone_mask", logger.MaskPhone(phone)).Msg("[msg91] dev mode — skipping send")
		return nil
	}
	if c.cfg.AuthKey == "" || c.cfg.TemplateID == "" {
		return ErrMSG91Misconfigured
	}

	mobile := normalizeForMSG91(phone)
	if mobile == "" {
		return fmt.Errorf("%w: invalid phone shape", ErrMSG91Rejected)
	}

	q := url.Values{}
	q.Set("authkey", c.cfg.AuthKey)
	q.Set("template_id", c.cfg.TemplateID)
	q.Set("mobile", mobile)
	if c.cfg.SenderID != "" {
		q.Set("sender", c.cfg.SenderID)
	}

	return c.do(ctx, "POST", "/otp", q)
}

// VerifyOTP checks the user-supplied code with MSG91. In dev mode the
// hardcoded value "9999" is accepted; anything else returns
// ErrOTPInvalid. In live mode it GETs /api/v5/otp/verify with
// authkey/mobile/otp. The OTP value is never logged in any path.
func (c *MSG91Client) VerifyOTP(ctx context.Context, phone, otp string) error {
	otp = strings.TrimSpace(otp)
	if otp == "" {
		return ErrOTPInvalid
	}

	if c.cfg.DevMode {
		if otp == devModeOTPVal {
			return nil
		}
		return ErrOTPInvalid
	}
	if c.cfg.AuthKey == "" {
		return ErrMSG91Misconfigured
	}

	mobile := normalizeForMSG91(phone)
	if mobile == "" {
		return fmt.Errorf("%w: invalid phone shape", ErrMSG91Rejected)
	}

	q := url.Values{}
	q.Set("authkey", c.cfg.AuthKey)
	q.Set("mobile", mobile)
	q.Set("otp", otp)

	err := c.do(ctx, "GET", "/otp/verify", q)
	if err == nil {
		return nil
	}
	// MSG91 returns 200 with {"type":"error","message":"OTP not match"}
	// for bad codes — surfaced as ErrMSG91Rejected by do(). Treat any
	// rejection as invalid OTP from the handler's POV.
	if errors.Is(err, ErrMSG91Rejected) {
		return ErrOTPInvalid
	}
	return err
}

// RetryOTP asks MSG91 to re-send the most recent OTP. retryType is
// "text" (SMS) or "voice"; default is "text".
func (c *MSG91Client) RetryOTP(ctx context.Context, phone, retryType string) error {
	if c.cfg.DevMode {
		return nil
	}
	if c.cfg.AuthKey == "" {
		return ErrMSG91Misconfigured
	}

	mobile := normalizeForMSG91(phone)
	if mobile == "" {
		return fmt.Errorf("%w: invalid phone shape", ErrMSG91Rejected)
	}
	if retryType != "voice" {
		retryType = "text"
	}

	q := url.Values{}
	q.Set("authkey", c.cfg.AuthKey)
	q.Set("mobile", mobile)
	q.Set("retrytype", retryType)
	return c.do(ctx, "GET", "/otp/retry", q)
}

// do performs an HTTP request and interprets MSG91's response
// envelope. MSG91 always replies 200; success is signaled by
// {"type":"success"}, failures by {"type":"error","message":"…"}.
func (c *MSG91Client) do(ctx context.Context, method, path string, q url.Values) error {
	reqURL := c.baseURL + path + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, method, reqURL, nil)
	if err != nil {
		return fmt.Errorf("%w: build request: %v", ErrMSG91Network, err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrMSG91Network, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return fmt.Errorf("%w: read response: %v", ErrMSG91Network, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%w: HTTP %d", ErrMSG91Rejected, resp.StatusCode)
	}

	var env struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	if jerr := json.Unmarshal(body, &env); jerr != nil {
		// Non-JSON body but 2xx — treat as success (MSG91 has occasionally
		// returned bare "success" strings on the retry endpoint).
		return nil
	}
	if strings.EqualFold(env.Type, "success") {
		return nil
	}
	return fmt.Errorf("%w: %s", ErrMSG91Rejected, env.Message)
}
