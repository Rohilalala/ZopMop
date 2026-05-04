package payments

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// RazorpayGateway calls the Razorpay Refunds API.
// Docs: https://razorpay.com/docs/api/refunds/
type RazorpayGateway struct {
	keyID     string
	keySecret string
	client    *http.Client
}

// NewRazorpayGateway returns a configured gateway, or nil if env keys are
// missing — caller should fall back to ManualGateway.
func NewRazorpayGateway() *RazorpayGateway {
	keyID := os.Getenv("RAZORPAY_KEY_ID")
	keySecret := os.Getenv("RAZORPAY_KEY_SECRET")
	if keyID == "" || keySecret == "" {
		return nil
	}
	return &RazorpayGateway{
		keyID:     keyID,
		keySecret: keySecret,
		client:    &http.Client{Timeout: 15 * time.Second},
	}
}

// Name returns "razorpay" for log/audit identification.
func (r *RazorpayGateway) Name() string { return "razorpay" }

// Refund calls POST /v1/payments/{paymentID}/refund. Returns the gateway's
// refund id on 2xx. COD payments are rejected with ErrUnsupportedMethod so
// the caller can drop them on the manual track.
func (r *RazorpayGateway) Refund(ctx context.Context, paymentID string, amountCents int64, method PaymentMethod) (*RefundResult, error) {
	if method == MethodCOD {
		return nil, ErrUnsupportedMethod
	}
	if paymentID == "" {
		return nil, fmt.Errorf("razorpay: empty payment_id")
	}
	body := map[string]any{"amount": amountCents, "speed": "normal"}
	payload, _ := json.Marshal(body)

	url := fmt.Sprintf("https://api.razorpay.com/v1/payments/%s/refund", paymentID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	auth := base64.StdEncoding.EncodeToString([]byte(r.keyID + ":" + r.keySecret))
	req.Header.Set("Authorization", "Basic "+auth)

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("razorpay: %w", err)
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &RefundResult{StatusCode: resp.StatusCode}, fmt.Errorf("razorpay: %s: %s", resp.Status, truncate(string(bodyBytes), 256))
	}
	var parsed struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(bodyBytes, &parsed)
	return &RefundResult{GatewayRefundID: parsed.ID, StatusCode: resp.StatusCode}, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
