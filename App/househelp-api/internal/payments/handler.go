package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler exposes payment-helper endpoints (currently only VPA validation
// via Cashfree Payouts). All routes require an authenticated user — the JWT
// middleware must wrap the route group before mounting these.
type Handler struct {
	cashfreeClientID     string
	cashfreeClientSecret string
	cashfreeBase         string
	client               *http.Client

	tokenMu      sync.Mutex
	cachedToken  string
	tokenExpires time.Time
}

// NewHandler returns a payments handler. If CASHFREE_* env keys are unset
// the handler still mounts but every call returns 503.
func NewHandler() *Handler {
	base := os.Getenv("CASHFREE_BASE_URL")
	if base == "" {
		switch strings.ToLower(os.Getenv("CASHFREE_ENV")) {
		case "production", "prod", "live":
			base = "https://payout-api.cashfree.com"
		default:
			base = "https://payout-gamma.cashfree.com"
		}
	}
	return &Handler{
		cashfreeClientID:     os.Getenv("CASHFREE_CLIENT_ID"),
		cashfreeClientSecret: os.Getenv("CASHFREE_CLIENT_SECRET"),
		cashfreeBase:         strings.TrimRight(base, "/"),
		client:               &http.Client{Timeout: 8 * time.Second},
	}
}

// RegisterRoutes mounts payment helper routes onto the given group. The group
// must already have JWT auth + rate limiting wired by the caller.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/validate-vpa", h.ValidateVPA)
}

// vpaFormat is a permissive UPI VPA pattern: handle@psp where handle is
// alnum/dot/dash/underscore (>=2 chars) and PSP is alpha (>=2 chars).
var vpaFormat = regexp.MustCompile(`^[A-Za-z0-9._\-]{2,}@[A-Za-z]{2,}$`)

type validateVPARequest struct {
	VPA  string `json:"vpa"`
	Name string `json:"name,omitempty"`
}

type validateVPAResponse struct {
	VPA          string `json:"vpa"`
	Valid        bool   `json:"valid"`
	CustomerName string `json:"customer_name,omitempty"`
	Error        string `json:"error,omitempty"`
}

// ValidateVPA proxies a VPA-validation call to Cashfree Payouts. Returns a
// trimmed payload — never the gateway's raw response. Cashfree's UPI
// validation returns `nameAtBank` for valid VPAs and a non-200/SUCCESS
// status for invalid ones; we map both to a stable shape for the client.
func (h *Handler) ValidateVPA(c *fiber.Ctx) error {
	if h.cashfreeClientID == "" || h.cashfreeClientSecret == "" {
		return c.Status(fiber.StatusServiceUnavailable).
			JSON(fiber.Map{"error": "vpa validation not configured"})
	}

	var body validateVPARequest
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	vpa := strings.TrimSpace(strings.ToLower(body.VPA))
	if !vpaFormat.MatchString(vpa) {
		return c.Status(fiber.StatusOK).JSON(validateVPAResponse{
			VPA: vpa, Valid: false, Error: "invalid format",
		})
	}

	ctx, cancel := context.WithTimeout(c.UserContext(), 6*time.Second)
	defer cancel()

	name, err := h.validateVPACashfree(ctx, vpa, strings.TrimSpace(body.Name))
	if err != nil {
		log.Warn().Err(err).Str("vpa", vpa).Msg("vpa validation gateway error")
		if errors.Is(err, errCashfreeVPAInvalid) {
			return c.Status(fiber.StatusOK).JSON(validateVPAResponse{
				VPA: vpa, Valid: false, Error: "vpa not found",
			})
		}
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{
			"error": "vpa lookup failed", "vpa": vpa,
		})
	}

	return c.JSON(validateVPAResponse{
		VPA: vpa, Valid: true, CustomerName: name,
	})
}

// errCashfreeVPAInvalid signals Cashfree rejected the VPA as not found.
// Callers should surface this as a 200 with valid:false rather than a 5xx.
var errCashfreeVPAInvalid = errors.New("cashfree: vpa invalid")

// cashfreeAuthToken returns a cached bearer token, refreshing it via
// /payout/v1/authorize when the cache is empty or about to expire.
func (h *Handler) cashfreeAuthToken(ctx context.Context) (string, error) {
	h.tokenMu.Lock()
	defer h.tokenMu.Unlock()

	if h.cachedToken != "" && time.Until(h.tokenExpires) > 60*time.Second {
		return h.cachedToken, nil
	}

	url := h.cashfreeBase + "/payout/v1/authorize"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-Client-Id", h.cashfreeClientID)
	req.Header.Set("X-Client-Secret", h.cashfreeClientSecret)
	req.Header.Set("Accept", "application/json")

	resp, err := h.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("cashfree authorize: %d: %s", resp.StatusCode, truncateForLog(string(bodyBytes), 200))
	}

	var parsed struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Data    struct {
			Token  string `json:"token"`
			Expiry int64  `json:"expiry"`
		} `json:"data"`
	}
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		return "", fmt.Errorf("cashfree authorize: parse: %w", err)
	}
	if parsed.Status != "SUCCESS" || parsed.Data.Token == "" {
		return "", fmt.Errorf("cashfree authorize: %s", parsed.Message)
	}

	h.cachedToken = parsed.Data.Token
	// Cashfree token TTL is ~30 min; default to 25 min if not provided.
	ttl := time.Duration(parsed.Data.Expiry) * time.Second
	if ttl < time.Minute {
		ttl = 25 * time.Minute
	}
	h.tokenExpires = time.Now().Add(ttl)
	return h.cachedToken, nil
}

func (h *Handler) validateVPACashfree(ctx context.Context, vpa, name string) (string, error) {
	token, err := h.cashfreeAuthToken(ctx)
	if err != nil {
		return "", err
	}

	reqBody := map[string]string{"vpa": vpa}
	if name != "" {
		reqBody["name"] = name
	}
	payload, _ := json.Marshal(reqBody)

	url := h.cashfreeBase + "/payout/v1/validation/upi"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := h.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)

	var parsed struct {
		Status    string `json:"status"`
		SubCode   string `json:"subCode"`
		Message   string `json:"message"`
		Data      struct {
			NameAtBank    string `json:"nameAtBank"`
			AccountExists string `json:"accountExists"`
			NameMatchScore string `json:"nameMatchScore"`
		} `json:"data"`
	}
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		return "", fmt.Errorf("cashfree validate: parse: %w (body=%s)", err, truncateForLog(string(bodyBytes), 200))
	}

	// Cashfree returns ERROR / FAILED for unknown VPAs; SUCCESS only when the
	// VPA is reachable and the bank confirms.
	if resp.StatusCode == http.StatusOK && parsed.Status == "SUCCESS" &&
		strings.EqualFold(parsed.Data.AccountExists, "YES") {
		return parsed.Data.NameAtBank, nil
	}
	if resp.StatusCode == http.StatusUnprocessableEntity ||
		strings.EqualFold(parsed.Status, "ERROR") ||
		strings.EqualFold(parsed.Status, "FAILED") {
		return "", errCashfreeVPAInvalid
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("cashfree validate: %d: %s", resp.StatusCode, truncateForLog(string(bodyBytes), 200))
	}
	return "", errCashfreeVPAInvalid
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
