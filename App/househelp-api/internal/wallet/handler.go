package wallet

import (
	"errors"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// TopupHandler is the contract the wallet handler uses to delegate /wallet/topup
// to the payments package without an import cycle. payments.Handler.CreateCashfreeOrder
// is wired through this interface from cmd/api/main.go.
type TopupHandler interface {
	HandleWalletTopup(c *fiber.Ctx, userID string, amountPaise int64) error
}

// Handler exposes /wallet routes. All routes require an authenticated user;
// caller mounts under a group with JWT middleware already wired.
type Handler struct {
	svc   *Service
	topup TopupHandler
}

// NewHandler constructs a wallet handler. topup may be nil — in that case
// /wallet/topup returns 503.
func NewHandler(svc *Service, topup TopupHandler) *Handler {
	return &Handler{svc: svc, topup: topup}
}

// RegisterRoutes mounts /wallet routes onto router.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Get("/", h.GetBalance)
	router.Get("/transactions", h.GetTransactions)
	router.Post("/topup", h.PostTopup)
}

// errResp matches the payments package's error contract: {error, code}.
type errResp struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeErr(c *fiber.Ctx, status int, code, msg string) error {
	return c.Status(status).JSON(errResp{Error: msg, Code: code})
}

// GET /wallet → { balance_paise }
func (h *Handler) GetBalance(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	if userID == "" {
		return writeErr(c, fiber.StatusUnauthorized, "unauthenticated", "authentication required")
	}
	bal, err := h.svc.GetBalance(c.UserContext(), userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("[wallet] get balance failed")
		return writeErr(c, fiber.StatusInternalServerError, "internal", "internal error")
	}
	return c.JSON(fiber.Map{"balance_paise": bal})
}

// GET /wallet/transactions?limit=20&before=<rfc3339>&before_id=<uuid>
func (h *Handler) GetTransactions(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	if userID == "" {
		return writeErr(c, fiber.StatusUnauthorized, "unauthenticated", "authentication required")
	}

	limit := 20
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	var (
		before   *time.Time
		beforeID string
	)
	if v := c.Query("before"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err == nil {
			before = &t
		}
	}
	beforeID = c.Query("before_id")

	rows, err := h.svc.History(c.UserContext(), userID, limit, before, beforeID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("[wallet] history failed")
		return writeErr(c, fiber.StatusInternalServerError, "internal", "internal error")
	}
	return c.JSON(fiber.Map{"transactions": rows})
}

type topupRequest struct {
	AmountPaise int64 `json:"amount_paise"`
}

// POST /wallet/topup → delegates to payments handler with
// payment_source=wallet_topup. Body: { amount_paise: int64 }. Returns
// the same shape as POST /payments/cashfree/order so the app can drive
// the Cashfree SDK with no extra branching.
func (h *Handler) PostTopup(c *fiber.Ctx) error {
	if h.topup == nil {
		return writeErr(c, fiber.StatusServiceUnavailable, "topup_unconfigured",
			"wallet topup not configured")
	}
	userID, _ := c.Locals("userID").(string)
	if userID == "" {
		return writeErr(c, fiber.StatusUnauthorized, "unauthenticated", "authentication required")
	}
	var req topupRequest
	if err := c.BodyParser(&req); err != nil {
		return writeErr(c, fiber.StatusBadRequest, "bad_body", "invalid request body")
	}
	return h.topup.HandleWalletTopup(c, userID, req.AmountPaise)
}

// Used by callers (e.g. booking flow) that want to map ErrInsufficientBalance
// to a stable HTTP code without importing wallet errors into their package.
func IsInsufficient(err error) bool {
	return errors.Is(err, ErrInsufficientBalance)
}
