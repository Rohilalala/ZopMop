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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/users"
	"github.com/adityarohilla/househelp-api/pkg/httpx"
	"github.com/adityarohilla/househelp-api/pkg/logger"
)

// Handler exposes payment-helper endpoints. Two distinct surfaces share the
// struct:
//
//  1. Cashfree Payouts (VPA validation) — the ValidateVPA route. Reads
//     CASHFREE_CLIENT_ID/SECRET via os.Getenv, runs against the payout-* host.
//
//  2. Cashfree PG (collection) — the /cashfree/order, /cashfree/orders/:id/status
//     and /cashfree/webhook routes. Backed by *CashfreeGateway constructed from
//     pkg/config and wired via SetCollectionDeps.
//
// All auth-protected routes require the JWT middleware on the group. The
// webhook route is mounted on a separate group with no auth — its
// authentication is the HMAC signature header, validated inside the handler.
type Handler struct {
	// ── Cashfree Payouts (VPA validation) — DO NOT REFACTOR ──
	cashfreeClientID     string
	cashfreeClientSecret string
	cashfreeBase         string
	client               *http.Client

	tokenMu      sync.Mutex
	cachedToken  string
	tokenExpires time.Time

	// ── Cashfree PG (collection) ──
	db            *pgxpool.Pool
	ledger        *Ledger
	gateway       *CashfreeGateway
	publicBaseURL string
	wallet        WalletCrediter
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
		client:               httpx.NewClient(8 * time.Second),
	}
}

// SetCollectionDeps wires the Cashfree PG (collection) dependencies. Called
// from cmd/api/main.go after gateway construction. Optional — leaving it
// unset disables the /cashfree/* routes (they 503).
func (h *Handler) SetCollectionDeps(db *pgxpool.Pool, ledger *Ledger, gateway *CashfreeGateway, publicBaseURL string) {
	h.db = db
	h.ledger = ledger
	h.gateway = gateway
	h.publicBaseURL = publicBaseURL
}

// WalletCrediter is the slice of the wallet service the webhook handler
// needs to credit a topup payment. Defined as an interface to avoid
// importing internal/wallet into internal/payments and creating a cycle —
// internal/wallet imports nothing from payments and the cycle would only
// surface if we typed against the concrete *wallet.Service here.
type WalletCrediter interface {
	CreditTx(
		ctx context.Context,
		tx pgx.Tx,
		userID string,
		amountPaise int64,
		kind string,
		paymentID, bookingID *string,
		note string,
	) error
}

// SetWallet wires the wallet service so PAYMENT_SUCCESS_WEBHOOK can credit
// the user's wallet for topup payments. Optional — when nil, the webhook
// handler still updates the ledger and emits the wallet.topped_up outbox
// event but skips the inline credit.
func (h *Handler) SetWallet(w WalletCrediter) { h.wallet = w }

// HandleWalletTopup is the contract /wallet/topup uses to delegate to the
// payments package. Lets the wallet handler call us without importing
// the route function directly.
func (h *Handler) HandleWalletTopup(c *fiber.Ctx, userID string, amountPaise int64) error {
	return h.createCashfreeOrderForWalletTopup(c, userID, amountPaise)
}

// RegisterRoutes mounts auth-protected payment routes onto the given group.
// The caller must already have JWT auth + rate limiting wired.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/validate-vpa", h.ValidateVPA)
	router.Post("/cashfree/order", h.CreateCashfreeOrder)
	router.Get("/cashfree/orders/:orderID/status", h.GetCashfreeOrderStatus)
}

// RegisterWebhookRoutes mounts the Cashfree webhook handler. The group
// passed in MUST NOT have auth middleware — Cashfree calls us without a
// JWT, and the request authenticates itself via the x-webhook-signature
// header (validated inside the handler).
func (h *Handler) RegisterWebhookRoutes(router fiber.Router) {
	router.Post("/cashfree/webhook", h.CashfreeWebhook)
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
		// Audit F1-D3: never log raw VPA. MaskVPA preserves the domain
		// (gateway-side fraud signal) while hiding the user-chosen handle.
		log.Warn().Err(err).Str("vpa_mask", logger.MaskVPA(vpa)).Msg("vpa validation gateway error")
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

// ════════════════════════════════════════════════════════════════════════
// Cashfree PG (collection) routes
// ════════════════════════════════════════════════════════════════════════

const (
	walletTopupMinPaise = 100     // ₹1
	walletTopupMaxPaise = 500_000 // ₹5,000

	// statusFreshnessWindow is how long a freshly-stamped
	// payments.webhook_received_at suppresses a live Cashfree fetch in the
	// status-poll handler. Short enough that the customer's poll loop
	// (every 3s) reliably picks up new state, long enough that we don't
	// hammer Cashfree from concurrent app instances.
	statusFreshnessWindow = 2 * time.Second
)

type createCashfreeOrderRequest struct {
	BookingID     string `json:"booking_id,omitempty"`
	PaymentSource string `json:"payment_source"` // "direct" | "wallet_topup"
	AmountPaise   int64  `json:"amount_paise,omitempty"`
}

type createCashfreeOrderResponse struct {
	PaymentSessionID string    `json:"payment_session_id"`
	OrderID          string    `json:"order_id"`
	AmountPaise      int64     `json:"amount_paise"`
	ExpiresAt        time.Time `json:"expires_at"`
}

type errorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

// errResp writes a structured error response in the contract documented
// in the Phase 4 prompt: { error, code } JSON, never a bare string.
func errResp(c *fiber.Ctx, status int, code, message string) error {
	return c.Status(status).JSON(errorBody{Error: message, Code: code})
}

// CreateCashfreeOrder is POST /payments/cashfree/order. See the master
// prompt's Phase 4 section for the full contract.
func (h *Handler) CreateCashfreeOrder(c *fiber.Ctx) error {
	if h.gateway == nil || h.ledger == nil || h.db == nil {
		return errResp(c, fiber.StatusServiceUnavailable, "gateway_unconfigured",
			"cashfree pg not configured")
	}
	userID, _ := c.Locals("userID").(string)
	if userID == "" {
		return errResp(c, fiber.StatusUnauthorized, "unauthenticated", "authentication required")
	}

	var req createCashfreeOrderRequest
	if err := c.BodyParser(&req); err != nil {
		return errResp(c, fiber.StatusBadRequest, "bad_body", "invalid request body")
	}

	switch req.PaymentSource {
	case "direct":
		return h.createCashfreeOrderForBooking(c, userID, req.BookingID)
	case "wallet_topup":
		return h.createCashfreeOrderForWalletTopup(c, userID, req.AmountPaise)
	default:
		return errResp(c, fiber.StatusBadRequest, "bad_payment_source",
			"payment_source must be 'direct' or 'wallet_topup'")
	}
}

// createCashfreeOrderForBooking handles payment_source="direct".
func (h *Handler) createCashfreeOrderForBooking(c *fiber.Ctx, userID, bookingID string) error {
	if bookingID == "" {
		return errResp(c, fiber.StatusBadRequest, "missing_booking_id",
			"booking_id is required for payment_source=direct")
	}

	ctx, cancel := context.WithTimeout(c.UserContext(), 15*time.Second)
	defer cancel()

	// Load booking + verify ownership + status.
	var (
		bookingCustomerID string
		amountPaise       int64
		discountPaise     int64
		walletApplied     int64
		status            string
	)
	err := h.db.QueryRow(ctx, `
		SELECT customer_id::text, amount_paise, COALESCE(discount_paise, 0), COALESCE(wallet_applied_paise, 0), status
		FROM bookings WHERE id = $1::uuid
	`, bookingID).Scan(&bookingCustomerID, &amountPaise, &discountPaise, &walletApplied, &status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errResp(c, fiber.StatusNotFound, "booking_not_found", "booking not found")
		}
		log.Error().Err(err).Str("booking_id", bookingID).Msg("[cashfree] load booking failed")
		return errResp(c, fiber.StatusInternalServerError, "internal", "internal error")
	}
	if bookingCustomerID != userID {
		return errResp(c, fiber.StatusForbidden, "not_owner", "booking does not belong to caller")
	}
	switch status {
	case "pending", "accepted":
		// OK to charge.
	case "completed":
		return errResp(c, fiber.StatusConflict, "already_completed",
			"booking already completed")
	case "cancelled":
		return errResp(c, fiber.StatusGone, "booking_cancelled", "booking has been cancelled")
	default:
		return errResp(c, fiber.StatusConflict, "bad_status",
			fmt.Sprintf("booking in status %s cannot be charged", status))
	}

	// Split bookings already debited wallet_applied_paise from the wallet at
	// create time; the Cashfree order charges only the remainder.
	netPaise := amountPaise - discountPaise - walletApplied
	if netPaise <= 0 {
		return errResp(c, fiber.StatusConflict, "zero_amount", "booking has zero amount due")
	}

	// Idempotency: reuse an existing pending+unexpired Cashfree order if one
	// exists for this booking. Avoids creating a second cf_order_id when the
	// app retries (e.g. user closed the sheet, came back, tapped Pay again).
	if reused, ok := h.findReusableCashfreeOrder(ctx, bookingID); ok {
		return c.JSON(reused)
	}

	// Idempotency on the gateway side: short-circuit if a successful
	// CASHFREE payment already lives against this booking. Scoped to
	// gateway='cashfree' so a split booking's wallet-portion payment row
	// (gateway='wallet', gateway_status='success') does NOT count as
	// "already paid" and block creating the order for the remaining
	// Cashfree leg.
	var alreadyPaid bool
	if err := h.db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM payments
		               WHERE booking_id = $1::uuid AND gateway = 'cashfree' AND gateway_status = 'success')
	`, bookingID).Scan(&alreadyPaid); err == nil && alreadyPaid {
		return errResp(c, fiber.StatusConflict, "already_paid", "booking already paid")
	}

	// LB-6: a pending Cashfree payment row with no live (unexpired) order
	// would block the partial unique index below and lock the customer out of
	// paying. Fail those dead rows first — they are exactly the rows
	// findReusableCashfreeOrder already refuses to reuse.
	if err := h.expireStalePendingCashfree(ctx, bookingID); err != nil {
		log.Warn().Err(err).Str("booking_id", bookingID).Msg("[cashfree] expire stale pending failed")
	}

	custPhone, custEmail, custName := h.loadCustomerDetails(ctx, userID)
	resp, err := h.openCashfreeOrder(ctx, &bookingID, userID, netPaise, custPhone, custEmail, custName, "Zopmop booking "+bookingID)
	if err != nil {
		// LB-6: a concurrent request won the race and created the single
		// allowed pending order (uq_payments_pending_cashfree_per_booking).
		// Reuse it rather than charging twice; if the winner's order isn't
		// visible yet (its gateway call is still in flight), tell the app to
		// retry — never open a second order.
		if isUniquePendingCashfreeViolation(err) {
			if reused, ok := h.findReusableCashfreeOrder(ctx, bookingID); ok {
				return c.JSON(reused)
			}
			return errResp(c, fiber.StatusConflict, "order_in_progress",
				"a payment order is already being created for this booking; retry shortly")
		}
		return h.translateGatewayError(c, err)
	}
	return c.JSON(resp)
}

// expireStalePendingCashfree marks as 'failed' any pending Cashfree payment for
// this booking that has no live (unexpired) cashfree_orders row — an expired
// order, or one whose gateway call died before the cashfree_orders insert.
// These are exactly the rows findReusableCashfreeOrder refuses to reuse; left
// pending they would block uq_payments_pending_cashfree_per_booking and stop
// the customer from opening a fresh order.
func (h *Handler) expireStalePendingCashfree(ctx context.Context, bookingID string) error {
	_, err := h.db.Exec(ctx, `
		UPDATE payments p SET gateway_status = 'failed'
		WHERE p.booking_id = $1::uuid
		  AND p.gateway = 'cashfree'
		  AND p.gateway_status = 'pending'
		  AND NOT EXISTS (
		      SELECT 1 FROM cashfree_orders co
		      WHERE co.payment_id = p.id AND co.expires_at > NOW()
		  )
	`, bookingID)
	return err
}

// isUniquePendingCashfreeViolation reports whether err is the unique violation
// raised by uq_payments_pending_cashfree_per_booking — i.e. a concurrent
// request already holds the one allowed pending order for this booking.
func isUniquePendingCashfreeViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) &&
		pgErr.Code == "23505" &&
		pgErr.ConstraintName == "uq_payments_pending_cashfree_per_booking"
}

// createCashfreeOrderForWalletTopup handles payment_source="wallet_topup".
func (h *Handler) createCashfreeOrderForWalletTopup(c *fiber.Ctx, userID string, amountPaise int64) error {
	if amountPaise < walletTopupMinPaise {
		return errResp(c, fiber.StatusPaymentRequired, "amount_too_low",
			fmt.Sprintf("topup amount must be at least %d paise", walletTopupMinPaise))
	}
	if amountPaise > walletTopupMaxPaise {
		return errResp(c, fiber.StatusPaymentRequired, "amount_too_high",
			fmt.Sprintf("topup amount must be at most %d paise", walletTopupMaxPaise))
	}

	ctx, cancel := context.WithTimeout(c.UserContext(), 15*time.Second)
	defer cancel()

	custPhone, custEmail, custName := h.loadCustomerDetails(ctx, userID)
	resp, err := h.openCashfreeOrder(ctx, nil, userID, amountPaise, custPhone, custEmail, custName, "Zopmop wallet topup")
	if err != nil {
		return h.translateGatewayError(c, err)
	}
	return c.JSON(resp)
}

// findReusableCashfreeOrder looks up the most recent pending Cashfree
// order for a booking. Returns the response shape if one exists and is
// not yet expired.
func (h *Handler) findReusableCashfreeOrder(ctx context.Context, bookingID string) (createCashfreeOrderResponse, bool) {
	var (
		paymentSessionID string
		orderID          string
		amountPaise      int64
		expiresAt        time.Time
	)
	err := h.db.QueryRow(ctx, `
		SELECT co.payment_session_id, co.order_id, p.amount_paise, co.expires_at
		FROM cashfree_orders co
		JOIN payments p ON p.id = co.payment_id
		WHERE p.booking_id = $1::uuid
		  AND p.gateway_status = 'pending'
		  AND co.expires_at > NOW()
		ORDER BY co.created_at DESC
		LIMIT 1
	`, bookingID).Scan(&paymentSessionID, &orderID, &amountPaise, &expiresAt)
	if err != nil {
		return createCashfreeOrderResponse{}, false
	}
	return createCashfreeOrderResponse{
		PaymentSessionID: paymentSessionID,
		OrderID:          orderID,
		AmountPaise:      amountPaise,
		ExpiresAt:        expiresAt,
	}, true
}

// loadCustomerDetails pulls phone / email / name for a user. Email gets
// synthesised when null because Cashfree requires customer_email on order
// creation. The synthetic mailbox is non-deliverable and explicitly
// flagged in the local part.
func (h *Handler) loadCustomerDetails(ctx context.Context, userID string) (phone, email, name string) {
	var (
		uPhone string
		uName  *string
		uEmail *string
	)
	if err := h.db.QueryRow(ctx,
		`SELECT phone, name, email FROM users WHERE id = $1::uuid AND `+users.AliveCondition,
		userID,
	).Scan(&uPhone, &uName, &uEmail); err != nil {
		log.Warn().Err(err).Str("user_id", userID).Msg("[cashfree] load customer details failed")
		return "", userID + "@noemail.zopmop.local", ""
	}
	phone = uPhone
	if uName != nil && strings.TrimSpace(*uName) != "" {
		name = *uName
	} else {
		// Fallback: phone-derived placeholder. The Cashfree Drop SDK uses
		// customer_name as the prefill hint on UPI VPA / cardholder name
		// fields. Sending an empty name strips the field server-side and
		// leaves the SDK form blank. A short placeholder is friendlier
		// than "Customer".
		name = "Zopmop Customer"
	}
	if uEmail != nil && *uEmail != "" {
		email = *uEmail
	} else {
		email = userID + "@noemail.zopmop.local"
	}
	return
}

// openCashfreeOrder is the shared inner workflow for direct + wallet_topup.
// Steps:
//  1. Insert payments row (booking_id may be nil for wallet topups).
//  2. Call gateway.CreateOrder.
//  3. Insert cashfree_orders row + update payments.gateway_ref.
//
// Steps 1 + 3 are not in a single transaction with the HTTP call (we don't
// want to hold a DB connection across a 15s gateway timeout). If step 2
// fails, the pending payment row is left behind — harmless, and the
// idempotency check in createCashfreeOrderForBooking will replace it on the
// next attempt. Wallet topup retries are stateless so leftover rows are
// equally harmless there.
func (h *Handler) openCashfreeOrder(ctx context.Context, bookingID *string, userID string, amountPaise int64, custPhone, custEmail, custName, note string) (*createCashfreeOrderResponse, error) {
	paymentID, err := h.ledger.CreatePayment(ctx, bookingID, userID, amountPaise, "cashfree", nil)
	if err != nil {
		return nil, fmt.Errorf("ledger create payment: %w", err)
	}

	ourOrderID := "zop-" + paymentID

	notifyURL := ""
	if h.publicBaseURL != "" {
		notifyURL = h.publicBaseURL + "/payments/cashfree/webhook"
	}

	cfResp, err := h.gateway.CreateOrder(ctx, CreateOrderInput{
		OrderID:       ourOrderID,
		AmountPaise:   amountPaise,
		Currency:      "INR",
		CustomerID:    userID,
		CustomerPhone: custPhone,
		CustomerEmail: custEmail,
		CustomerName:  custName,
		OrderNote:     note,
		NotifyURL:     notifyURL,
	})
	if err != nil {
		return nil, fmt.Errorf("cashfree create order: %w", err)
	}

	tx, err := h.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(context.Background())

	if _, err := tx.Exec(ctx, `
		INSERT INTO cashfree_orders
		  (payment_id, cf_order_id, order_id, payment_session_id, order_status, expires_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6)
	`, paymentID, cfResp.CFOrderID, cfResp.OrderID, cfResp.PaymentSessionID, cfResp.OrderStatus, cfResp.ExpiresAt); err != nil {
		return nil, fmt.Errorf("insert cashfree_orders: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE payments SET gateway_ref = $2 WHERE id = $1::uuid`,
		paymentID, cfResp.CFOrderID,
	); err != nil {
		return nil, fmt.Errorf("update payment gateway_ref: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &createCashfreeOrderResponse{
		PaymentSessionID: cfResp.PaymentSessionID,
		OrderID:          cfResp.OrderID,
		AmountPaise:      amountPaise,
		ExpiresAt:        cfResp.ExpiresAt,
	}, nil
}

// translateGatewayError maps a gateway-side failure to a 5xx response with a
// stable error code so the app can decide whether to retry or escalate.
func (h *Handler) translateGatewayError(c *fiber.Ctx, err error) error {
	log.Error().Err(err).Msg("[cashfree] order creation failed")
	if strings.Contains(err.Error(), "cashfree:") {
		return errResp(c, fiber.StatusBadGateway, "gateway_error", "payment gateway error")
	}
	return errResp(c, fiber.StatusInternalServerError, "internal", "internal error")
}

// ────────────────────────────────────────────────────────────────────────
// GET /payments/cashfree/orders/:orderID/status
// ────────────────────────────────────────────────────────────────────────

type cashfreeOrderStatusResponse struct {
	Status      string     `json:"status"`        // pending | success | failed | refunded
	AmountPaise int64      `json:"amount_paise"`
	PaidAt      *time.Time `json:"paid_at,omitempty"`
}

// GetCashfreeOrderStatus polls Cashfree when our local row is still pending.
func (h *Handler) GetCashfreeOrderStatus(c *fiber.Ctx) error {
	if h.gateway == nil || h.ledger == nil || h.db == nil {
		return errResp(c, fiber.StatusServiceUnavailable, "gateway_unconfigured",
			"cashfree pg not configured")
	}
	userID, _ := c.Locals("userID").(string)
	if userID == "" {
		return errResp(c, fiber.StatusUnauthorized, "unauthenticated", "authentication required")
	}
	orderID := c.Params("orderID")
	if orderID == "" {
		return errResp(c, fiber.StatusBadRequest, "missing_order_id", "order_id is required")
	}

	ctx, cancel := context.WithTimeout(c.UserContext(), 10*time.Second)
	defer cancel()

	var (
		paymentUserID     string
		gatewayStatus     string
		amountPaise       int64
		webhookReceivedAt *time.Time
		cfOrderID         string
	)
	err := h.db.QueryRow(ctx, `
		SELECT p.user_id::text, p.gateway_status, p.amount_paise, p.webhook_received_at,
		       co.cf_order_id
		FROM cashfree_orders co
		JOIN payments p ON p.id = co.payment_id
		WHERE co.order_id = $1
	`, orderID).Scan(&paymentUserID, &gatewayStatus, &amountPaise, &webhookReceivedAt, &cfOrderID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errResp(c, fiber.StatusNotFound, "order_not_found", "order not found")
		}
		log.Error().Err(err).Str("order_id", orderID).Msg("[cashfree] load order status failed")
		return errResp(c, fiber.StatusInternalServerError, "internal", "internal error")
	}
	if paymentUserID != userID {
		return errResp(c, fiber.StatusForbidden, "not_owner", "order does not belong to caller")
	}

	// Live-fetch from Cashfree only when local state is still pending and
	// we haven't seen a webhook within the freshness window.
	fresh := webhookReceivedAt != nil && time.Since(*webhookReceivedAt) < statusFreshnessWindow
	if gatewayStatus == "pending" && !fresh {
		live, err := h.gateway.FetchOrder(ctx, orderID)
		if err == nil && live != nil {
			mapped := mapCashfreeOrderStatus(live.Status)
			if mapped != "" && mapped != gatewayStatus {
				if err := h.ledger.UpdateStatusByGatewayRef(ctx, cfOrderID, mapped, time.Now().UTC()); err != nil {
					log.Warn().Err(err).Str("order_id", orderID).Msg("[cashfree] persist live status failed")
				}
				gatewayStatus = mapped
				now := time.Now().UTC()
				webhookReceivedAt = &now
			}
		} else if err != nil {
			log.Warn().Err(err).Str("order_id", orderID).Msg("[cashfree] live fetch failed")
		}
	}

	resp := cashfreeOrderStatusResponse{Status: gatewayStatus, AmountPaise: amountPaise}
	if gatewayStatus == "success" {
		resp.PaidAt = webhookReceivedAt
	}
	return c.JSON(resp)
}

// mapCashfreeOrderStatus translates a Cashfree order_status string to our
// gateway_status enum (pending|success|failed|refunded). Returns "" for
// unfamiliar values so the caller leaves local state alone.
func mapCashfreeOrderStatus(cf string) string {
	switch strings.ToUpper(cf) {
	case "ACTIVE":
		return "pending"
	case "PAID":
		return "success"
	case "EXPIRED", "TERMINATED", "TERMINATION_REQUESTED":
		return "failed"
	}
	return ""
}

// ────────────────────────────────────────────────────────────────────────
// POST /payments/cashfree/webhook
// ────────────────────────────────────────────────────────────────────────

// cashfreeWebhookEnvelope is the trimmed shape we read off Cashfree's
// webhook payload. Only fields we actually consume are typed; unknown
// fields land in the JSONB outbox payload via the raw body.
type cashfreeWebhookEnvelope struct {
	Type    string                 `json:"type"`
	EventID string                 `json:"event_id,omitempty"`
	Data    cashfreeWebhookData    `json:"data"`
	RawType string                 // populated from `type` for non-PG events
	Tags    map[string]interface{} `json:"-"`
}

type cashfreeWebhookData struct {
	Order   cashfreeWebhookOrder   `json:"order"`
	Payment cashfreeWebhookPayment `json:"payment"`
	Refund  cashfreeWebhookRefund  `json:"refund"`
}

type cashfreeWebhookOrder struct {
	OrderID     string  `json:"order_id"`
	CFOrderID   any     `json:"cf_order_id"` // sometimes int, sometimes string
	OrderStatus string  `json:"order_status"`
	OrderAmount float64 `json:"order_amount"`
}

type cashfreeWebhookPayment struct {
	CFPaymentID    any     `json:"cf_payment_id"` // sometimes int, sometimes string
	PaymentStatus  string  `json:"payment_status"`
	PaymentAmount  float64 `json:"payment_amount"`
	PaymentTime    string  `json:"payment_time"`
	PaymentMessage string  `json:"payment_message"`
}

type cashfreeWebhookRefund struct {
	CFRefundID   any    `json:"cf_refund_id"`
	RefundStatus string `json:"refund_status"`
	RefundAmount float64 `json:"refund_amount"`
}

// CashfreeWebhook is the public entry point for the gateway-→server callback.
//
// Auth model: NO JWT. Auth is the HMAC signature header. Anything reaching
// this handler with an invalid signature must be rejected immediately
// without touching state — log enough to attribute the call but never the
// candidate signature.
func (h *Handler) CashfreeWebhook(c *fiber.Ctx) error {
	if h.gateway == nil || h.ledger == nil || h.db == nil {
		return c.Status(fiber.StatusServiceUnavailable).
			SendString("cashfree pg not configured")
	}

	// IMPORTANT: read raw body first. Re-marshaled JSON breaks the HMAC.
	rawBody := c.Body()
	timestamp := c.Get("x-webhook-timestamp")
	signature := c.Get("x-webhook-signature")

	if err := h.gateway.VerifyWebhookSignature(rawBody, timestamp, signature); err != nil {
		// Log enough to investigate without leaking the signature value:
		// length and a 4-char prefix for log-correlation only.
		sigLen := len(signature)
		sigHint := ""
		if sigLen >= 4 {
			sigHint = signature[:4]
		}
		log.Warn().
			Err(err).
			Int("sig_len", sigLen).
			Str("sig_hint", sigHint).
			Str("ts", timestamp).
			Msg("[cashfree] webhook signature rejected")
		switch {
		case errors.Is(err, ErrWebhookStale):
			return c.Status(fiber.StatusGone).JSON(fiber.Map{
				"error": "webhook signature timestamp outside replay window",
				"code":  "stale_signature",
			})
		default:
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid webhook signature",
				"code":  "bad_signature",
			})
		}
	}

	// Merchant Dashboard test pings come with a "source-type" header. They
	// have no `data.payment` block; drop them on the floor with a 200 so
	// the dashboard's "test webhook" button shows green.
	if strings.EqualFold(c.Get("source-type"), "MERCHANT_DASHBOARD") {
		log.Info().Msg("[cashfree] merchant dashboard test webhook acknowledged")
		return c.SendStatus(fiber.StatusOK)
	}

	var env cashfreeWebhookEnvelope
	if err := json.Unmarshal(rawBody, &env); err != nil {
		log.Warn().Err(err).Msg("[cashfree] webhook unparseable")
		return c.SendStatus(fiber.StatusBadRequest)
	}
	if env.Type == "" {
		log.Warn().Msg("[cashfree] webhook missing type")
		return c.SendStatus(fiber.StatusBadRequest)
	}
	if env.Type == "WEBHOOK" {
		// Cashfree's plain "WEBHOOK" envelope with no data block — treat as
		// a test ping and ack.
		return c.SendStatus(fiber.StatusOK)
	}

	cfPaymentID := stringifyAny(env.Data.Payment.CFPaymentID)
	cfOrderID := stringifyAny(env.Data.Order.CFOrderID)
	orderID := env.Data.Order.OrderID
	eventID := env.EventID
	if eventID == "" {
		eventID = cfPaymentID
	}
	if eventID == "" {
		eventID = env.Type + ":" + orderID
	}

	receivedAt := time.Now().UTC()
	processCtx, cancel := context.WithTimeout(c.UserContext(), 15*time.Second)
	defer cancel()

	err := ConsumeOnceTx(processCtx, h.db, eventID, func(ctx context.Context, tx pgx.Tx) error {
		return h.dispatchCashfreeEventTx(ctx, tx, env.Type, orderID, cfOrderID, cfPaymentID, receivedAt, rawBody)
	})
	if err != nil {
		log.Error().
			Err(err).
			Str("type", env.Type).
			Str("order_id", orderID).
			Str("cf_payment_id_redacted", redactID(cfPaymentID)).
			Msg("[cashfree] webhook dispatch failed")
		// Return 200 so Cashfree does not retry on our own bug — we don't
		// want a hot retry loop for an event we've actually seen. Log is
		// the source of truth for incident response. Note: because
		// ConsumeOnceTx rolled back, the dedupe row was NOT recorded, so
		// Cashfree's own retry of the same event_id will re-enter dispatch.
		return c.SendStatus(fiber.StatusOK)
	}

	return c.SendStatus(fiber.StatusOK)
}

// dispatchCashfreeEventTx routes one verified, deduped webhook payload to
// the right side-effect path. ALL writes (ledger update + event_outbox
// insert) execute against the supplied tx, so they commit atomically with
// the ConsumeOnceTx claim or roll back together.
//
// Concurrency: SELECT … FOR UPDATE on the payment row serialises concurrent
// webhook deliveries for the same order. Cashfree occasionally fires two
// PAYMENT_SUCCESS callbacks within milliseconds of each other (e.g. UPI
// retry); without the row lock we could double-update or interleave with
// a refund event. The migration 070 unique index on event_outbox is the
// final backstop.
func (h *Handler) dispatchCashfreeEventTx(ctx context.Context, tx pgx.Tx, eventType, orderID, cfOrderID, cfPaymentID string, receivedAt time.Time, rawBody []byte) error {
	var (
		paymentID      string
		paymentUserID  string
		paymentBooking *string
		amountPaise    int64
		paymentRef     string
	)
	err := tx.QueryRow(ctx, `
		SELECT p.id::text, p.user_id::text, p.booking_id::text, p.amount_paise,
		       COALESCE(p.gateway_ref, co.cf_order_id)
		FROM cashfree_orders co
		JOIN payments p ON p.id = co.payment_id
		WHERE co.order_id = $1
		FOR UPDATE OF p
	`, orderID).Scan(&paymentID, &paymentUserID, &paymentBooking, &amountPaise, &paymentRef)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lookup payment by order_id: %w", err)
	}
	noPaymentRow := errors.Is(err, pgx.ErrNoRows)

	logger := log.With().
		Str("type", eventType).
		Str("order_id", orderID).
		Str("cf_order_id_redacted", redactID(cfOrderID)).
		Str("cf_payment_id_redacted", redactID(cfPaymentID)).
		Logger()

	switch eventType {
	case "PAYMENT_SUCCESS_WEBHOOK":
		if noPaymentRow {
			logger.Warn().Msg("[cashfree] success webhook for unknown order")
			return nil
		}
		if err := h.ledger.UpdateStatusByGatewayRefTx(ctx, tx, paymentRef, "success", receivedAt); err != nil {
			return fmt.Errorf("update success status: %w", err)
		}
		if paymentBooking != nil && *paymentBooking != "" {
			// A successful Cashfree payment settled THIS booking (paymentBooking
			// is resolved from the order's own payments row, so it's
			// unambiguous). Mark it paid AND stamp payment_method='cashfree' —
			// the latter matters for the pay-online-anytime path on a COD
			// booking: the customer can pay the nudge online, which converts the
			// row to a paid online booking (END OTP unlocks; the customer-list
			// filter admits it; collect-cash is now gated out, so no double
			// charge). Previously this was scoped `AND payment_method='cashfree'`
			// which left COD-paid-online bookings stuck unpaid forever.
			if _, err := tx.Exec(ctx,
				`UPDATE bookings
				 SET payment_status = 'paid', payment_method = 'cashfree', updated_at = NOW()
				 WHERE id = $1::uuid`,
				*paymentBooking,
			); err != nil {
				return fmt.Errorf("stamp booking payment_status=paid: %w", err)
			}
			if err := emitBookingPaidEventTx(ctx, tx, *paymentBooking, paymentUserID, paymentID, amountPaise, paymentRef, receivedAt); err != nil {
				return fmt.Errorf("emit booking.paid: %w", err)
			}
		} else {
			// Wallet topup. Credit the wallet inside the same tx — the
			// wallet service emits its own wallet.credited event_outbox row,
			// and we additionally emit wallet.topped_up so a downstream
			// consumer can attribute the credit to the gateway transaction
			// without joining tables.
			if h.wallet != nil {
				pid := paymentID
				if err := h.wallet.CreditTx(ctx, tx, paymentUserID, amountPaise, "topup", &pid, nil, "Cashfree topup"); err != nil {
					return fmt.Errorf("wallet credit topup: %w", err)
				}
			} else {
				logger.Warn().Msg("[cashfree] wallet service not wired; topup ledger updated but balance not credited")
			}
			if err := emitWalletTopupEventTx(ctx, tx, paymentUserID, paymentID, amountPaise, paymentRef, receivedAt); err != nil {
				return fmt.Errorf("emit wallet.topped_up: %w", err)
			}
		}

	case "PAYMENT_FAILED_WEBHOOK", "PAYMENT_USER_DROPPED_WEBHOOK":
		if noPaymentRow {
			logger.Warn().Msg("[cashfree] failed/dropped webhook for unknown order")
			return nil
		}
		if err := h.ledger.UpdateStatusByGatewayRefTx(ctx, tx, paymentRef, "failed", receivedAt); err != nil {
			return fmt.Errorf("update failed status: %w", err)
		}

	case "REFUND_STATUS_WEBHOOK":
		var env cashfreeWebhookEnvelope
		_ = json.Unmarshal(rawBody, &env)
		if !strings.EqualFold(env.Data.Refund.RefundStatus, "SUCCESS") {
			logger.Info().Str("refund_status", env.Data.Refund.RefundStatus).Msg("[cashfree] non-success refund event ignored")
			return nil
		}
		if noPaymentRow {
			logger.Warn().Msg("[cashfree] refund webhook for unknown order")
			return nil
		}
		if err := h.ledger.UpdateStatusByGatewayRefTx(ctx, tx, paymentRef, "refunded", receivedAt); err != nil {
			return fmt.Errorf("update refunded status: %w", err)
		}

	default:
		logger.Info().Msg("[cashfree] unhandled event type")
	}
	return nil
}

// emitBookingPaidEventTx writes a booking.paid row to event_outbox via the
// supplied tx. Drainer is future work; right now this is a durable record
// committed atomically with the matching ledger update.
func emitBookingPaidEventTx(ctx context.Context, tx pgx.Tx, bookingID, userID, paymentID string, amountPaise int64, gatewayRef string, paidAt time.Time) error {
	payload, err := json.Marshal(map[string]any{
		"booking_id":   bookingID,
		"user_id":      userID,
		"payment_id":   paymentID,
		"amount_paise": amountPaise,
		"gateway":      "cashfree",
		"gateway_ref":  gatewayRef,
		"paid_at":      paidAt.Format(time.RFC3339),
	})
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO event_outbox (event_type, aggregate_id, payload)
		VALUES ($1, $2::uuid, $3::jsonb)
	`, "booking.paid", bookingID, payload)
	return err
}

// emitWalletTopupEventTx writes a wallet.topped_up row to event_outbox via
// the supplied tx.
func emitWalletTopupEventTx(ctx context.Context, tx pgx.Tx, userID, paymentID string, amountPaise int64, gatewayRef string, paidAt time.Time) error {
	payload, err := json.Marshal(map[string]any{
		"user_id":      userID,
		"payment_id":   paymentID,
		"amount_paise": amountPaise,
		"gateway":      "cashfree",
		"gateway_ref":  gatewayRef,
		"paid_at":      paidAt.Format(time.RFC3339),
	})
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO event_outbox (event_type, aggregate_id, payload)
		VALUES ($1, $2::uuid, $3::jsonb)
	`, "wallet.topped_up", userID, payload)
	return err
}

// stringifyAny coerces a JSON value (number or string) to its string form.
// Cashfree payloads sometimes type cf_payment_id as a number, sometimes as
// a string; this normalises both.
func stringifyAny(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatInt(int64(x), 10)
	case int64:
		return strconv.FormatInt(x, 10)
	case json.Number:
		return string(x)
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}
