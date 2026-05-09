package payments

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/pkg/config"
	"github.com/adityarohilla/househelp-api/pkg/httpx"
)

// Webhook signature failure counters. Exposed via WebhookMetrics() for the
// /admin/runtime/metrics endpoint. Clock-skew failures indicate NTP drift
// on the host; HMAC failures indicate misconfigured secrets or replay attempts.
var (
	webhookClockSkewFailures atomic.Int64
	webhookHMACFailures      atomic.Int64
)

// WebhookMetrics returns current webhook signature failure counts.
func WebhookMetrics() map[string]int64 {
	return map[string]int64{
		"cashfree_webhook_clock_skew_failures_total": webhookClockSkewFailures.Load(),
		"cashfree_webhook_hmac_failures_total":       webhookHMACFailures.Load(),
	}
}

// Cashfree PG (collection) endpoints. Distinct from the Cashfree Payouts
// surface used in handler.go for VPA validation — different product, hosts,
// and credentials.
const (
	cashfreePGSandboxBase = "https://sandbox.cashfree.com/pg"
	cashfreePGProdBase    = "https://api.cashfree.com/pg"

	// API version pinned on every request. Bump deliberately when the
	// gateway ships breaking changes; floating onto whatever Cashfree
	// defaults to is asking for surprise outages.
	cashfreeAPIVersion = "2025-01-01"

	// Webhook replay-protection window. Signatures with timestamps outside
	// ±300s of server time are rejected even if the HMAC matches.
	cashfreeWebhookMaxSkew = 300 * time.Second
)

// CashfreeGateway implements Gateway (Refund + Name) plus the collection-side
// methods (CreateOrder / FetchOrder / FetchPayments / VerifyWebhookSignature).
// Returned by NewCashfreeGateway when CASHFREE_PG_APP_ID is set; otherwise
// the constructor returns nil and callers fall back to ManualGateway.
type CashfreeGateway struct {
	appID         string
	secretKey     string
	baseURL       string
	webhookSecret string
	http          *http.Client
	log           zerolog.Logger
}

// NewCashfreeGateway constructs a configured gateway, or nil when
// cfg.CashfreePGAppID is empty. Mirrors the old Razorpay constructor's
// fail-soft contract so callers can do `if g := NewCashfreeGateway(cfg); g != nil`.
//
// Validation of paired keys happens upstream in pkg/config — by the time we
// land here either everything is set or AppID is empty.
func NewCashfreeGateway(cfg *config.Config) *CashfreeGateway {
	if cfg == nil || cfg.CashfreePGAppID == "" {
		return nil
	}
	base := cashfreePGSandboxBase
	if cfg.CashfreePGEnv == "production" {
		base = cashfreePGProdBase
	}
	return &CashfreeGateway{
		appID:         cfg.CashfreePGAppID,
		secretKey:     cfg.CashfreePGSecretKey,
		baseURL:       base,
		webhookSecret: cfg.CashfreePGWebhookSecret,
		http:          httpx.NewClient(15 * time.Second),
		log:           log.With().Str("component", "cashfree-pg").Logger(),
	}
}

// Name identifies the gateway in audit log + ledger rows.
func (c *CashfreeGateway) Name() string { return "cashfree" }

// ── Gateway interface ───────────────────────────────────────────────────

// Refund issues a refund against a captured payment. Cashfree expects the
// amount in rupees (float). We convert from paise at the boundary — internal
// state stays in paise. COD payments are rejected with ErrUnsupportedMethod
// so the caller marks them processed_manual.
//
// Endpoint: POST /pg/orders/{order_id}/refunds
// Cashfree treats the order id as the natural key for refunds; paymentID
// here is interpreted as the order id (callers fetch this from
// payments.gateway_ref). When we move to capture-style flows we'll need to
// flip to /pg/payments/{cf_payment_id}/refund — flag for revisit.
//
// idempotencyKey is the caller-supplied merchant refund identifier. We
// translate it into Cashfree's body field "refund_id", which Cashfree
// itself enforces as the per-merchant dedup key (v2025-01-01 contract):
// the same refund_id resubmitted returns the existing refund record
// rather than triggering a second money movement. This is defense-in-
// depth against double-refund TOCTOU on the caller side (audit B1-1).
// Falls back to a time-based id only if the caller passes an empty
// string — that path is for the unauthenticated / pre-row-id flows that
// don't exist today.
func (c *CashfreeGateway) Refund(ctx context.Context, paymentID string, amountPaise int64, method PaymentMethod, idempotencyKey string) (*RefundResult, error) {
	if method == MethodCOD {
		return nil, ErrUnsupportedMethod
	}
	if paymentID == "" {
		return nil, fmt.Errorf("cashfree: empty order_id for refund")
	}
	if amountPaise <= 0 {
		return nil, fmt.Errorf("cashfree: refund amount must be positive")
	}

	refundID := "rfnd-" + idempotencyKey
	if idempotencyKey == "" {
		refundID = fmt.Sprintf("rfnd-%d", time.Now().UnixNano())
	}
	body := map[string]any{
		"refund_amount": paiseToRupees(amountPaise),
		"refund_id":     refundID,
		"refund_note":   "automated refund",
	}
	url := c.baseURL + "/orders/" + paymentID + "/refunds"

	resp, status, err := c.do(ctx, http.MethodPost, url, body)
	if err != nil {
		return &RefundResult{StatusCode: status}, err
	}

	var parsed struct {
		CFRefundID string `json:"cf_refund_id"`
		RefundID   string `json:"refund_id"`
	}
	_ = json.Unmarshal(resp, &parsed)
	gatewayRef := parsed.CFRefundID
	if gatewayRef == "" {
		gatewayRef = parsed.RefundID
	}
	return &RefundResult{
		GatewayRefundID: gatewayRef,
		StatusCode:      status,
	}, nil
}

// ── Collection methods (not on Gateway interface) ───────────────────────

// CreateOrderInput is the input shape for CreateOrder. AmountPaise is
// converted to rupees-with-2-decimals at the API boundary.
type CreateOrderInput struct {
	OrderID         string // our id, sent to Cashfree as order_id
	AmountPaise     int64
	Currency        string // default "INR" when empty
	CustomerID      string
	CustomerPhone   string
	CustomerEmail   string // synthesise <userID>@noemail.zopmop.local upstream when null
	CustomerName    string
	OrderNote       string
	ReturnURL       string // optional; populated for hosted-checkout flows
	NotifyURL       string // server-side webhook URL
	OrderTags       map[string]string
	OrderExpiryTime *time.Time // optional; defaults handled by Cashfree
}

// CreateOrderOutput is the response we surface to the React Native app.
type CreateOrderOutput struct {
	CFOrderID         string    // Cashfree's id (cf_order_id)
	OrderID           string    // our id, echoed back
	PaymentSessionID  string    // consumed by the SDK's doWebPayment
	OrderStatus       string    // typically "ACTIVE" on creation
	OrderCurrency     string
	OrderAmountRupees float64
	ExpiresAt         time.Time
}

// CreateOrder calls POST /orders. Returns the payment_session_id the RN app
// passes to the Cashfree SDK to launch the hosted checkout. We never touch
// card / UPI handle / netbanking creds; the SDK collects them.
func (c *CashfreeGateway) CreateOrder(ctx context.Context, in CreateOrderInput) (*CreateOrderOutput, error) {
	if in.OrderID == "" {
		return nil, fmt.Errorf("cashfree: order_id is required")
	}
	if in.AmountPaise <= 0 {
		return nil, fmt.Errorf("cashfree: amount must be positive")
	}
	if in.CustomerID == "" || in.CustomerPhone == "" {
		return nil, fmt.Errorf("cashfree: customer_id and phone are required")
	}
	currency := in.Currency
	if currency == "" {
		currency = "INR"
	}
	customerDetails := map[string]any{
		"customer_id":    in.CustomerID,
		"customer_phone": in.CustomerPhone,
	}
	if in.CustomerEmail != "" {
		customerDetails["customer_email"] = in.CustomerEmail
	}
	if in.CustomerName != "" {
		customerDetails["customer_name"] = in.CustomerName
	}
	body := map[string]any{
		"order_id":         in.OrderID,
		"order_amount":     paiseToRupees(in.AmountPaise),
		"order_currency":   currency,
		"customer_details": customerDetails,
	}
	if in.OrderNote != "" {
		body["order_note"] = in.OrderNote
	}
	if len(in.OrderTags) > 0 {
		body["order_tags"] = in.OrderTags
	}
	if in.OrderExpiryTime != nil {
		body["order_expiry_time"] = in.OrderExpiryTime.UTC().Format(time.RFC3339)
	}
	meta := map[string]any{}
	if in.NotifyURL != "" {
		meta["notify_url"] = in.NotifyURL
	}
	if in.ReturnURL != "" {
		meta["return_url"] = in.ReturnURL
	}
	if len(meta) > 0 {
		body["order_meta"] = meta
	}

	resp, _, err := c.do(ctx, http.MethodPost, c.baseURL+"/orders", body)
	if err != nil {
		return nil, err
	}

	var parsed struct {
		CFOrderID        string  `json:"cf_order_id"`
		OrderID          string  `json:"order_id"`
		PaymentSessionID string  `json:"payment_session_id"`
		OrderStatus      string  `json:"order_status"`
		OrderCurrency    string  `json:"order_currency"`
		OrderAmount      float64 `json:"order_amount"`
		OrderExpiryTime  string  `json:"order_expiry_time"`
	}
	if err := json.Unmarshal(resp, &parsed); err != nil {
		return nil, fmt.Errorf("cashfree: parse create-order response: %w", err)
	}
	if parsed.PaymentSessionID == "" {
		return nil, fmt.Errorf("cashfree: empty payment_session_id in response")
	}

	expiresAt, _ := time.Parse(time.RFC3339, parsed.OrderExpiryTime)
	if expiresAt.IsZero() {
		// Cashfree default: 30 days. Pin the local default so the
		// cashfree_orders.expires_at column is always populated.
		expiresAt = time.Now().Add(30 * 24 * time.Hour)
	}

	c.log.Info().
		Str("cf_order_id_redacted", redactID(parsed.CFOrderID)).
		Str("payment_session_id_redacted", redactID(parsed.PaymentSessionID)).
		Str("order_id", parsed.OrderID).
		Float64("amount_rupees", parsed.OrderAmount).
		Msg("cashfree order created")

	return &CreateOrderOutput{
		CFOrderID:         parsed.CFOrderID,
		OrderID:           parsed.OrderID,
		PaymentSessionID:  parsed.PaymentSessionID,
		OrderStatus:       parsed.OrderStatus,
		OrderCurrency:     parsed.OrderCurrency,
		OrderAmountRupees: parsed.OrderAmount,
		ExpiresAt:         expiresAt,
	}, nil
}

// OrderStatus is the trimmed view of GET /orders/:orderID — the fields we
// actually consume in the status-poll endpoint. Status mirrors Cashfree:
// ACTIVE | PAID | EXPIRED | TERMINATED | TERMINATION_REQUESTED.
type OrderStatus struct {
	OrderID           string
	CFOrderID         string
	Status            string
	OrderAmountRupees float64
	OrderCurrency     string
	CreatedAt         time.Time
}

// FetchOrder calls GET /orders/:orderID. Used by the status-poll endpoint
// when local payments.gateway_status is still pending.
func (c *CashfreeGateway) FetchOrder(ctx context.Context, orderID string) (*OrderStatus, error) {
	if orderID == "" {
		return nil, fmt.Errorf("cashfree: order_id is required")
	}
	resp, _, err := c.do(ctx, http.MethodGet, c.baseURL+"/orders/"+orderID, nil)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		OrderID       string  `json:"order_id"`
		CFOrderID     string  `json:"cf_order_id"`
		OrderStatus   string  `json:"order_status"`
		OrderAmount   float64 `json:"order_amount"`
		OrderCurrency string  `json:"order_currency"`
		CreatedAt     string  `json:"created_at"`
	}
	if err := json.Unmarshal(resp, &parsed); err != nil {
		return nil, fmt.Errorf("cashfree: parse fetch-order response: %w", err)
	}
	createdAt, _ := time.Parse(time.RFC3339, parsed.CreatedAt)
	return &OrderStatus{
		OrderID:           parsed.OrderID,
		CFOrderID:         parsed.CFOrderID,
		Status:            parsed.OrderStatus,
		OrderAmountRupees: parsed.OrderAmount,
		OrderCurrency:     parsed.OrderCurrency,
		CreatedAt:         createdAt,
	}, nil
}

// CFPayment is one row from GET /orders/:orderID/payments — Cashfree returns
// a list because multi-attempt flows can produce several rows per order.
type CFPayment struct {
	CFPaymentID       string
	OrderID           string
	PaymentStatus     string  // SUCCESS | PENDING | FAILED | USER_DROPPED
	PaymentAmount     float64 // rupees
	PaymentCurrency   string
	PaymentMethod     string  // upi | card | netbanking | wallet | …
	PaymentTime       time.Time
	PaymentMessage    string
}

// FetchPayments calls GET /orders/:orderID/payments. Returned slice may be
// empty if no payment attempt has been made against the order yet.
func (c *CashfreeGateway) FetchPayments(ctx context.Context, orderID string) ([]CFPayment, error) {
	if orderID == "" {
		return nil, fmt.Errorf("cashfree: order_id is required")
	}
	resp, _, err := c.do(ctx, http.MethodGet, c.baseURL+"/orders/"+orderID+"/payments", nil)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		CFPaymentID     int64           `json:"cf_payment_id"`
		OrderID         string          `json:"order_id"`
		PaymentStatus   string          `json:"payment_status"`
		PaymentAmount   float64         `json:"payment_amount"`
		PaymentCurrency string          `json:"payment_currency"`
		PaymentMethod   json.RawMessage `json:"payment_method"`
		PaymentTime     string          `json:"payment_time"`
		PaymentMessage  string          `json:"payment_message"`
	}
	if err := json.Unmarshal(resp, &rows); err != nil {
		return nil, fmt.Errorf("cashfree: parse fetch-payments response: %w", err)
	}
	out := make([]CFPayment, 0, len(rows))
	for _, r := range rows {
		t, _ := time.Parse(time.RFC3339, r.PaymentTime)
		out = append(out, CFPayment{
			CFPaymentID:     strconv.FormatInt(r.CFPaymentID, 10),
			OrderID:         r.OrderID,
			PaymentStatus:   r.PaymentStatus,
			PaymentAmount:   r.PaymentAmount,
			PaymentCurrency: r.PaymentCurrency,
			PaymentMethod:   extractMethodKey(r.PaymentMethod),
			PaymentTime:     t,
			PaymentMessage:  r.PaymentMessage,
		})
	}
	return out, nil
}

// ── Webhook signature verification ──────────────────────────────────────

// ErrWebhookBadSignature is returned by VerifyWebhookSignature when HMAC
// comparison fails. Callers must return 401 on this — never 5xx, never
// retry-friendly, never log the candidate signature value.
var ErrWebhookBadSignature = errors.New("cashfree: webhook signature mismatch")

// ErrWebhookStale is returned when the timestamp is older / newer than the
// allowed skew window. Treated identically to a bad signature by the
// caller (401), distinguished only for diagnostics.
var ErrWebhookStale = errors.New("cashfree: webhook timestamp outside replay window")

// VerifyWebhookSignature validates the x-webhook-signature header against
// HMAC-SHA256(webhookSecret, timestamp + raw_body). Per Cashfree docs the
// timestamp is the literal x-webhook-timestamp header value (seconds since
// epoch as a string), concatenated to the raw body with NO separator,
// then HMAC'd, then base64-encoded.
//
// rawBody MUST be the un-parsed request body (Fiber: c.Body()). Re-encoded
// JSON will produce a different signature even if semantically equal.
func (c *CashfreeGateway) VerifyWebhookSignature(rawBody []byte, timestamp, signature string) error {
	if c.webhookSecret == "" {
		return fmt.Errorf("cashfree: webhook secret not configured")
	}
	if timestamp == "" || signature == "" {
		return ErrWebhookBadSignature
	}
	tsInt, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return ErrWebhookBadSignature
	}
	skew := time.Since(time.Unix(tsInt, 0))
	if skew < 0 {
		skew = -skew
	}
	if skew > cashfreeWebhookMaxSkew {
		webhookClockSkewFailures.Add(1)
		log.Warn().Dur("skew", skew).Msg("[cashfree] webhook timestamp outside replay window — possible NTP drift")
		return ErrWebhookStale
	}

	mac := hmac.New(sha256.New, []byte(c.webhookSecret))
	mac.Write([]byte(timestamp))
	mac.Write(rawBody)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(expected), []byte(signature)) {
		webhookHMACFailures.Add(1)
		return ErrWebhookBadSignature
	}
	return nil
}

// ── Internal HTTP plumbing ──────────────────────────────────────────────

// do sends a JSON request with the standard Cashfree headers and reads the
// full response body. Returns (body, statusCode, err) where err is set on
// transport errors AND on non-2xx HTTP status (body included so callers
// can surface gateway error messages).
func (c *CashfreeGateway) do(ctx context.Context, method, url string, body any) ([]byte, int, error) {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("cashfree: marshal request: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("cashfree: build request: %w", err)
	}
	req.Header.Set("x-client-id", c.appID)
	req.Header.Set("x-client-secret", c.secretKey)
	req.Header.Set("x-api-version", cashfreeAPIVersion)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("cashfree: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return respBody, resp.StatusCode, fmt.Errorf("cashfree: %s: %s", resp.Status, truncate(string(respBody), 256))
	}
	return respBody, resp.StatusCode, nil
}

// paiseToRupees converts an integer paise amount to a rupees float Cashfree
// will accept. Cashfree's API takes amounts as JSON numbers, with two
// decimal places of precision; dividing by 100 is exact for integer inputs.
func paiseToRupees(paise int64) float64 {
	return float64(paise) / 100.0
}

// extractMethodKey pulls the top-level method name out of the wrapped
// payment_method object Cashfree returns (e.g. {"upi":{...}} → "upi").
// Returns empty string when the shape is unfamiliar.
func extractMethodKey(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	for k := range m {
		return k
	}
	return ""
}

// redactID exposes the first 8 chars of an opaque gateway id with a "…"
// suffix. Use at info level. The full value is debug-only — see the
// constraint in the Phase 4 prompt: never log full payment_session_id /
// cf_order_id / cf_payment_id at info+.
func redactID(s string) string {
	if len(s) <= 8 {
		return s
	}
	return s[:8] + "…"
}

// truncate is a guard against logging entire gateway error bodies on hot
// paths — keeps log lines bounded.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
