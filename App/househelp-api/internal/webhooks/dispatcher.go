// Package webhooks is a shared dispatcher for outbound CRM webhooks.
//
// Both cmd/api (user-facing app) and cmd/crm-api (admin) import this package
// and call Dispatch(ctx, event, payload) when a domain event needs to fan out
// to subscribed webhook endpoints. Delivery is asynchronous: the call returns
// immediately and a goroutine takes over signing, sending, and persisting the
// crm_webhook_deliveries row. The Replay and Test methods are synchronous so
// the CRM UI can render the result inline.
package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Delivery mirrors a row in crm_webhook_deliveries. JSON tags match what the
// CRM UI already reads (status_code/response) — the spec column rename is a
// storage detail, not an API change.
type Delivery struct {
	ID             int64           `json:"id"`
	WebhookID      string          `json:"webhook_id"`
	Event          string          `json:"event"`
	Payload        json.RawMessage `json:"payload"`
	ResponseStatus int             `json:"status_code"`
	ResponseBody   string          `json:"response_body"`
	DurationMS     *int            `json:"duration_ms,omitempty"`
	Attempt        int             `json:"attempt"`
	Succeeded      bool            `json:"succeeded"`
	RetriedAt      *time.Time      `json:"retried_at,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
}

const (
	defaultHTTPTimeout    = 10 * time.Second
	defaultMaxConcurrency = 64
	defaultBodyCap        = 1024 // bytes of response we persist
	userAgent             = "zopmop-webhooks/1"
)

// Option configures the Dispatcher at construction time.
type Option func(*Dispatcher)

// WithHTTPTimeout overrides the per-request HTTP timeout (default 10s).
func WithHTTPTimeout(d time.Duration) Option {
	return func(dp *Dispatcher) { dp.httpTimeout = d }
}

// WithMaxConcurrency caps in-flight delivery goroutines (default 64).
func WithMaxConcurrency(n int) Option {
	return func(dp *Dispatcher) {
		if n > 0 {
			dp.sem = make(chan struct{}, n)
		}
	}
}

// WithAllowedDomains sets the domain allowlist for outbound webhook targets.
// When non-empty, webhook delivery is rejected unless the destination hostname
// matches one of the listed domains (or is a subdomain of one). If empty,
// any non-private domain is permitted. Configure via ALLOWED_WEBHOOK_DOMAINS.
func WithAllowedDomains(domains []string) Option {
	return func(dp *Dispatcher) { dp.allowedDomains = domains }
}

// Dispatcher is shared between services; safe for concurrent use.
type Dispatcher struct {
	pool           *pgxpool.Pool
	client         *http.Client
	httpTimeout    time.Duration
	sem            chan struct{}
	wg             sync.WaitGroup
	allowedDomains []string
}

// New constructs a Dispatcher with sane defaults.
func New(pool *pgxpool.Pool, opts ...Option) *Dispatcher {
	d := &Dispatcher{
		pool:        pool,
		httpTimeout: defaultHTTPTimeout,
		sem:         make(chan struct{}, defaultMaxConcurrency),
	}
	for _, opt := range opts {
		opt(d)
	}
	d.client = &http.Client{Timeout: d.httpTimeout}
	return d
}

// Close waits for in-flight deliveries up to the ctx deadline.
func (d *Dispatcher) Close(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		d.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Dispatch is fire-and-forget. The caller's ctx is only used for the initial
// subscriber lookup; delivery itself runs on context.Background() so a
// finishing HTTP request doesn't cancel the outbound POST.
func (d *Dispatcher) Dispatch(ctx context.Context, event string, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error().Err(err).Str("event", event).Msg("[webhooks] marshal payload failed")
		return
	}
	subs, err := d.subscribers(ctx, event)
	if err != nil {
		log.Error().Err(err).Str("event", event).Msg("[webhooks] subscriber lookup failed")
		return
	}
	for _, s := range subs {
		// Acquire BEFORE spawn so a large fan-out doesn't briefly create
		// goroutines beyond the cap (audit NEW-B1-002). The blocking
		// receive on a full channel applies natural back-pressure to
		// Dispatch instead of letting the goroutine count balloon.
		d.sem <- struct{}{}
		s := s
		d.wg.Go(func() {
			defer func() { <-d.sem }()
			d.deliverWithRetry(context.Background(), s, event, body)
		})
	}
}

// deliverWithRetry runs deliver() up to maxDeliveryAttempts times, with
// jittered exponential backoff between attempts (audit D4-N2). Each
// attempt persists its own crm_webhook_deliveries row so the audit
// trail shows the retry timeline. Stops on 2xx (success) or 4xx
// (client errors won't be fixed by retry); retries 5xx, transport
// errors, and timeouts.
func (d *Dispatcher) deliverWithRetry(ctx context.Context, s subscriber, event string, body []byte) {
	const (
		maxDeliveryAttempts = 3
		baseDelay           = 500 * time.Millisecond
	)
	for attempt := 1; attempt <= maxDeliveryAttempts; attempt++ {
		dlv, err := d.deliver(ctx, s, event, body, attempt, false)
		if err != nil {
			log.Error().Err(err).Str("event", event).Str("webhook_id", s.ID).Int("attempt", attempt).Msg("[webhooks] delivery persist failed")
			return
		}
		if dlv.Succeeded {
			return
		}
		// 4xx: client error, retrying is futile. Persisted row already
		// records the failure for the CRM history view.
		if dlv.ResponseStatus >= 400 && dlv.ResponseStatus < 500 {
			return
		}
		if attempt == maxDeliveryAttempts {
			return
		}
		// Jittered exponential backoff: 500ms, 1s, 2s + 0-50% jitter.
		delay := baseDelay * (1 << (attempt - 1))
		jitterNanos, err := rand.Int(rand.Reader, big.NewInt(int64(delay/2)))
		if err == nil {
			delay += time.Duration(jitterNanos.Int64())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

// Replay re-fires a stored delivery to the same webhook, creates a new
// delivery row, and stamps retried_at on the original.
func (d *Dispatcher) Replay(ctx context.Context, deliveryID int64) (int64, error) {
	var (
		webhookID string
		event     string
		payload   []byte
		attempt   int
		url       string
		secret    *string
		active    bool
	)
	err := d.pool.QueryRow(ctx, `
		SELECT d.webhook_id::text, d.event, d.payload, d.attempt, w.url, w.secret, w.is_active
		FROM crm_webhook_deliveries d
		JOIN crm_webhooks w ON w.id = d.webhook_id
		WHERE d.id = $1
	`, deliveryID).Scan(&webhookID, &event, &payload, &attempt, &url, &secret, &active)
	if err != nil {
		return 0, fmt.Errorf("load delivery: %w", err)
	}
	if !active {
		return 0, errors.New("webhook is inactive")
	}
	sec := ""
	if secret != nil {
		sec = *secret
	}
	sub := subscriber{ID: webhookID, URL: url, Secret: sec}
	dlv, err := d.deliver(ctx, sub, event, payload, attempt+1, false)
	if err != nil {
		return 0, err
	}
	if _, err := d.pool.Exec(ctx,
		`UPDATE crm_webhook_deliveries SET retried_at = now() WHERE id = $1`, deliveryID); err != nil {
		log.Error().Err(err).Int64("delivery_id", deliveryID).Msg("[webhooks] mark retried_at failed")
	}
	return dlv.ID, nil
}

// Test fires a synthetic payload to a single webhook and returns the delivery
// row for inline rendering in the CRM UI.
func (d *Dispatcher) Test(ctx context.Context, webhookID string, event string, sample any) (Delivery, error) {
	if event == "" {
		event = "test.ping"
	}
	if sample == nil {
		sample = map[string]any{
			"message": "hello from zopmop",
			"ts":      time.Now().Unix(),
		}
	}
	body, err := json.Marshal(sample)
	if err != nil {
		return Delivery{}, fmt.Errorf("marshal sample: %w", err)
	}
	var (
		url    string
		secret *string
		active bool
	)
	if err := d.pool.QueryRow(ctx,
		`SELECT url, secret, is_active FROM crm_webhooks WHERE id = $1::uuid`, webhookID,
	).Scan(&url, &secret, &active); err != nil {
		return Delivery{}, fmt.Errorf("load webhook: %w", err)
	}
	if !active {
		return Delivery{}, errors.New("webhook is inactive")
	}
	sec := ""
	if secret != nil {
		sec = *secret
	}
	return d.deliver(ctx, subscriber{ID: webhookID, URL: url, Secret: sec}, event, body, 1, true)
}

// ── internals ──────────────────────────────────────────────────────────

type subscriber struct {
	ID     string
	URL    string
	Secret string
}

func (d *Dispatcher) subscribers(ctx context.Context, event string) ([]subscriber, error) {
	rows, err := d.pool.Query(ctx, `
		SELECT id::text, url, secret
		FROM crm_webhooks
		WHERE is_active = true AND $1 = ANY(events)
	`, event)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []subscriber{}
	for rows.Next() {
		var s subscriber
		var sec *string
		if err := rows.Scan(&s.ID, &s.URL, &sec); err != nil {
			return nil, err
		}
		if sec != nil {
			s.Secret = *sec
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// deliver performs the HTTP POST, persists the result, and returns the row.
// Errors returned here are persistence errors; HTTP-layer errors are recorded
// in the row itself (status 0, body=err.Error()).
func (d *Dispatcher) deliver(ctx context.Context, s subscriber, event string, body []byte, attempt int, isTest bool) (Delivery, error) {
	// SSRF gate (audit NEW-A2-001): reject obvious private targets before
	// the HTTP call. Persist the rejection so admins can see the failure
	// in the CRM delivery list. DNS-rebinding still requires network-level
	// egress filtering — see ssrf.go comment.
	if err := validateWebhookTarget(s.URL, d.allowedDomains); err != nil {
		log.Warn().Err(err).Str("webhook_id", s.ID).Str("url", s.URL).Msg("[webhooks] target rejected")
		return d.persist(ctx, s.ID, event, body, 0, truncate(err.Error(), defaultBodyCap), nil, attempt, false)
	}
	deliveryUUID := uuid.NewString()
	reqCtx, cancel := context.WithTimeout(ctx, d.httpTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, s.URL, bytes.NewReader(body))
	if err != nil {
		return d.persist(ctx, s.ID, event, body, 0, "build request: "+err.Error(), nil, attempt, false)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("X-Zopmop-Event", event)
	req.Header.Set("X-Zopmop-Delivery-ID", deliveryUUID)
	req.Header.Set("X-Zopmop-Timestamp", strconv.FormatInt(time.Now().Unix(), 10))
	if s.Secret != "" {
		req.Header.Set("X-Zopmop-Signature", signPayload(s.Secret, body))
	}
	if isTest {
		req.Header.Set("X-Zopmop-Test", "1")
	}

	start := time.Now()
	resp, err := d.client.Do(req)
	durMS := int(time.Since(start).Milliseconds())

	if err != nil {
		log.Warn().Err(err).Str("webhook_id", s.ID).Str("event", event).Msg("[webhooks] http request failed")
		return d.persist(ctx, s.ID, event, body, 0, truncate(err.Error(), defaultBodyCap), &durMS, attempt, false)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, defaultBodyCap))
	succeeded := resp.StatusCode >= 200 && resp.StatusCode < 300

	return d.persist(ctx, s.ID, event, body, resp.StatusCode, string(respBody), &durMS, attempt, succeeded)
}

func (d *Dispatcher) persist(ctx context.Context, webhookID, event string, payload []byte, status int, respBody string, durMS *int, attempt int, succeeded bool) (Delivery, error) {
	var dlv Delivery
	err := d.pool.QueryRow(ctx, `
		INSERT INTO crm_webhook_deliveries
		    (webhook_id, event, payload, response_status, response_body, duration_ms, attempt, succeeded)
		VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8)
		RETURNING id, webhook_id::text, event, payload, response_status, response_body,
		          duration_ms, attempt, succeeded, retried_at, created_at
	`, webhookID, event, payload, status, truncate(respBody, defaultBodyCap), durMS, attempt, succeeded,
	).Scan(&dlv.ID, &dlv.WebhookID, &dlv.Event, &dlv.Payload, &dlv.ResponseStatus, &dlv.ResponseBody,
		&dlv.DurationMS, &dlv.Attempt, &dlv.Succeeded, &dlv.RetriedAt, &dlv.CreatedAt)
	return dlv, err
}

// signPayload returns hex(HMAC-SHA256(body, secret)).
func signPayload(secret string, body []byte) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
