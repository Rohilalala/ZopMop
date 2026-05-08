// Package refunds wraps the existing pending_refunds table for the CRM.
// Approval / partial / rejection are admin-driven; T1.6 wires this package
// to the payment gateway abstraction (internal/payments) so an Approve call
// either fires a real gateway refund (Cashfree) or marks the row as
// processed_manual when no gateway is configured / the original payment was
// COD.
package refunds

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/auth"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
)

var (
	ErrNotFound = errors.New("refund not found")
	// ErrAlreadyClaimed is returned by lockForApproval when the row is no
	// longer in the expected prior status. Surfaces as HTTP 409 — another
	// concurrent caller already owns the gateway call. The caller MUST NOT
	// proceed to the gateway when this is returned (audit B1-1).
	ErrAlreadyClaimed = errors.New("refund already claimed by another caller")
)

type Item struct {
	ID          string     `json:"id"`
	UserID      string     `json:"user_id"`
	UserName    *string    `json:"user_name,omitempty"`
	UserPhone   string     `json:"user_phone"`
	AmountCents int64      `json:"amount_cents"`
	Source      string     `json:"source"`
	SourceRef   *string    `json:"source_ref,omitempty"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	SettledAt   *time.Time `json:"settled_at,omitempty"`
}

type DecisionRequest struct {
	AmountCents *int64 `json:"amount_cents"` // nil = full
	Reason      string `json:"reason"        validate:"required,min=2,max=500"`
}

// bookingMeta is the payment-side context loaded for a refund. Either
// resolved through the new pending_refunds.booking_id column or, for legacy
// rows, by treating source_ref as a booking id when source is "booking_*".
type bookingMeta struct {
	BookingID     string
	PaymentMethod string
	PaymentID     string
}

type Repository struct{ read, write *pgxpool.Pool }

func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

// List returns refunds matching status (empty = all).
func (r *Repository) List(ctx context.Context, status string, limit, offset int) ([]Item, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	args := []any{}
	cond := ""
	if status != "" {
		args = append(args, status)
		cond = "WHERE pr.status = $1"
	}
	args = append(args, limit, offset)
	limitParam, offsetParam := len(args)-1, len(args)
	rows, err := r.read.Query(ctx, fmt.Sprintf(`
		SELECT pr.id::text, pr.user_id::text, u.name, COALESCE(u.phone, '(deleted)'),
		       pr.amount_cents, pr.source, pr.source_ref, pr.status,
		       pr.created_at, pr.settled_at
		FROM pending_refunds pr
		LEFT JOIN users u ON u.id = pr.user_id AND u.deleted_at IS NULL
		%s
		ORDER BY pr.created_at DESC
		LIMIT $%d OFFSET $%d
	`, cond, limitParam, offsetParam), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list refunds: %w", err)
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var i Item
		if err := rows.Scan(&i.ID, &i.UserID, &i.UserName, &i.UserPhone,
			&i.AmountCents, &i.Source, &i.SourceRef, &i.Status,
			&i.CreatedAt, &i.SettledAt); err != nil {
			return nil, 0, err
		}
		out = append(out, i)
	}

	countArgs := args[:len(args)-2]
	countSQL := fmt.Sprintf(`SELECT COUNT(*) FROM pending_refunds pr %s`, cond)
	var total int
	if err := r.read.QueryRow(ctx, countSQL, countArgs...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count refunds: %w", err)
	}
	return out, total, nil
}

// Get returns one refund row.
func (r *Repository) Get(ctx context.Context, id string) (*Item, error) {
	var i Item
	err := r.read.QueryRow(ctx, `
		SELECT pr.id::text, pr.user_id::text, u.name, COALESCE(u.phone, '(deleted)'),
		       pr.amount_cents, pr.source, pr.source_ref, pr.status,
		       pr.created_at, pr.settled_at
		FROM pending_refunds pr
		LEFT JOIN users u ON u.id = pr.user_id AND u.deleted_at IS NULL
		WHERE pr.id = $1::uuid
	`, id).Scan(&i.ID, &i.UserID, &i.UserName, &i.UserPhone,
		&i.AmountCents, &i.Source, &i.SourceRef, &i.Status,
		&i.CreatedAt, &i.SettledAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &i, nil
}

// resolveBookingMeta loads payment context for a refund. Resolution order:
//
//  1. The new pending_refunds.booking_id column (preferred — once producers
//     start populating it).
//  2. Backward compat: if source LIKE 'booking_%' and source_ref looks like
//     a UUID, treat source_ref as the booking id.
//
// Returns a meta with empty BookingID when the refund isn't tied to a
// booking (e.g. roomies_group_delete) — caller falls back to manual.
func (r *Repository) resolveBookingMeta(ctx context.Context, refundID string) (bookingMeta, error) {
	var (
		bookingID     *string
		prMethod      *string
		prPaymentID   *string
		source        string
		sourceRef     *string
	)
	err := r.read.QueryRow(ctx, `
		SELECT booking_id::text, payment_method, payment_id, source, source_ref
		FROM pending_refunds WHERE id = $1::uuid
	`, refundID).Scan(&bookingID, &prMethod, &prPaymentID, &source, &sourceRef)
	if err != nil {
		return bookingMeta{}, err
	}

	resolvedBookingID := ""
	if bookingID != nil && *bookingID != "" {
		resolvedBookingID = *bookingID
	} else if strings.HasPrefix(source, "booking") && sourceRef != nil && looksLikeUUID(*sourceRef) {
		resolvedBookingID = *sourceRef
	}

	meta := bookingMeta{BookingID: resolvedBookingID}
	if prMethod != nil {
		meta.PaymentMethod = *prMethod
	}
	if prPaymentID != nil {
		meta.PaymentID = *prPaymentID
	}

	// If we have a booking but no explicit payment metadata on the refund,
	// pull it from bookings (populated by the new payment_method/payment_id
	// columns once the gateway lands on the user-app side).
	if resolvedBookingID != "" && (meta.PaymentMethod == "" || meta.PaymentID == "") {
		var bMethod, bPayID *string
		_ = r.read.QueryRow(ctx, `
			SELECT payment_method, payment_id FROM bookings WHERE id = $1::uuid
		`, resolvedBookingID).Scan(&bMethod, &bPayID)
		if meta.PaymentMethod == "" && bMethod != nil {
			meta.PaymentMethod = *bMethod
		}
		if meta.PaymentID == "" && bPayID != nil {
			meta.PaymentID = *bPayID
		}
	}
	return meta, nil
}

func looksLikeUUID(s string) bool {
	// 8-4-4-4-12 = 36 chars including dashes.
	return len(s) == 36 && s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-'
}

// findActiveRefundForBooking returns the id of any non-terminal refund that
// already exists against a booking, so we can fail fast with a friendly error
// before the unique index does it for us.
func (r *Repository) findActiveRefundForBooking(ctx context.Context, bookingID, excludeID string) (string, time.Time, bool, error) {
	if bookingID == "" {
		return "", time.Time{}, false, nil
	}
	var (
		id        string
		processed *time.Time
		settled   *time.Time
	)
	err := r.read.QueryRow(ctx, `
		SELECT id::text, processed_at, settled_at
		FROM pending_refunds
		WHERE booking_id = $1::uuid
		  AND id <> $2::uuid
		  AND status IN ('approved','processed','processed_manual')
		ORDER BY created_at DESC
		LIMIT 1
	`, bookingID, excludeID).Scan(&id, &processed, &settled)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, err
	}
	when := time.Time{}
	if processed != nil {
		when = *processed
	} else if settled != nil {
		when = *settled
	}
	return id, when, true, nil
}

// Reject marks the refund rejected.
func (r *Repository) Reject(ctx context.Context, id string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE pending_refunds SET status = 'rejected', settled_at = now()
		WHERE id = $1::uuid AND status = 'pending'
	`, id)
	if err != nil {
		return fmt.Errorf("reject refund: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// lockForApproval atomically flips a refund row from one of the allowed
// prior statuses (e.g. "pending" for Approve, "gateway_error" for Retry) to
// the in-flight lock status "approved". Only one concurrent caller wins
// this UPDATE; the rest see RowsAffected=0 and receive ErrAlreadyClaimed.
//
// 'approved' is repurposed here as the in-flight lock state. The schema's
// CHECK constraint already allows it (migration 046); no existing code
// writes it. After the gateway returns, the row transitions:
//   - 'approved' → 'processed' / 'processed_manual'   (success)
//   - 'approved' → 'gateway_error'                    (failure, retryable)
//
// MUST be called BEFORE the gateway invocation. Calling the gateway before
// this CAS is exactly the TOCTOU race that audit B1-1 flagged: two parallel
// Approve clicks both pass a status read and both fire the gateway, double-
// refunding the customer.
func (r *Repository) lockForApproval(ctx context.Context, id string, allowedPriorStatuses []string) error {
	if len(allowedPriorStatuses) == 0 {
		return fmt.Errorf("lockForApproval: missing allowed prior statuses")
	}
	placeholders := make([]string, len(allowedPriorStatuses))
	args := []any{id}
	for i, s := range allowedPriorStatuses {
		placeholders[i] = fmt.Sprintf("$%d", i+2)
		args = append(args, s)
	}
	sql := fmt.Sprintf(`
		UPDATE pending_refunds
		SET status = 'approved'
		WHERE id = $1::uuid AND status IN (%s)
	`, strings.Join(placeholders, ", "))
	res, err := r.write.Exec(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("lock refund for approval: %w", err)
	}
	if res.RowsAffected() == 0 {
		// Disambiguate: races with another admin approve will leave status
		// in {'approved','processed','failed','rejected'}; an unexpected
		// status (NULL row, schema drift) is a louder signal worth a WARN
		// (audit NEW-B3-001).
		var current string
		if qerr := r.write.QueryRow(ctx, `SELECT status FROM pending_refunds WHERE id = $1::uuid`, id).Scan(&current); qerr != nil {
			log.Warn().Err(qerr).Str("refund_id", id).Msg("[refunds] lockForApproval: status lookup after CAS miss failed")
		} else {
			expected := map[string]struct{}{
				"pending": {}, "approved": {}, "processed": {},
				"processed_manual": {}, "gateway_error": {}, "rejected": {},
				"failed": {}, "settled": {},
			}
			if _, ok := expected[current]; !ok {
				log.Warn().Str("refund_id", id).Str("invalid_status", current).Msg("[refunds] lockForApproval: refund row has unrecognised status")
			}
		}
		return ErrAlreadyClaimed
	}
	return nil
}

// approveUpdate writes the result of a gateway call back to pending_refunds.
// finalAmount mirrors the (possibly partial) amount the admin approved.
// adminID may be empty for system-driven flows.
func (r *Repository) approveUpdate(
	ctx context.Context,
	id, newStatus, gatewayRefundID, errMsg, adminID, paymentMethod, paymentID string,
	finalAmount int64,
	processedAt *time.Time,
	allowedPriorStatuses []string,
) error {
	// Build the IN-list for the WHERE clause as positional args so we don't
	// have to deal with array binding gotchas across pgx versions.
	if len(allowedPriorStatuses) == 0 {
		return fmt.Errorf("approveUpdate: missing allowed prior statuses")
	}
	setClauses := []string{
		"status = $2",
		"gateway_refund_id = NULLIF($3, '')",
		"error_message = NULLIF($4, '')",
		"partial_amount_cents = $5",
		"payment_method = COALESCE(NULLIF($6, ''), payment_method)",
		"payment_id = COALESCE(NULLIF($7, ''), payment_id)",
		// pgx5 deduces a single Postgres type per parameter across the whole
		// statement. $2 is used both as the column-typed assignment for
		// status (varchar) and inside this IN-clause against text literals;
		// without an explicit cast pgx5 fails with SQLSTATE 42P08
		// "inconsistent types deduced for parameter $2". The ::varchar pin
		// matches the pending_refunds.status column type and resolves the
		// ambiguity.
		"settled_at = CASE WHEN $2::varchar IN ('processed','processed_manual','rejected','cancelled') THEN now() ELSE settled_at END",
	}
	nextArg := 8
	if adminID != "" {
		setClauses = append(setClauses, fmt.Sprintf("approved_by = $%d::uuid, approved_at = COALESCE(approved_at, now())", nextArg))
		nextArg++
	}
	if processedAt != nil {
		setClauses = append(setClauses, fmt.Sprintf("processed_at = $%d", nextArg))
		nextArg++
	}
	// Now placeholders for status IN clause start at nextArg.
	statusArgsSlice := make([]string, len(allowedPriorStatuses))
	rebuiltArgs := []any{
		id, newStatus, gatewayRefundID, errMsg, finalAmount, paymentMethod, paymentID,
	}
	if adminID != "" {
		rebuiltArgs = append(rebuiltArgs, adminID)
	}
	if processedAt != nil {
		rebuiltArgs = append(rebuiltArgs, *processedAt)
	}
	for i, s := range allowedPriorStatuses {
		rebuiltArgs = append(rebuiltArgs, s)
		statusArgsSlice[i] = fmt.Sprintf("$%d", nextArg+i)
	}

	sql := fmt.Sprintf(`
		UPDATE pending_refunds
		SET %s
		WHERE id = $1::uuid AND status IN (%s)
	`, strings.Join(setClauses, ", "), strings.Join(statusArgsSlice, ", "))

	res, err := r.write.Exec(ctx, sql, rebuiltArgs...)
	if err != nil {
		return fmt.Errorf("approve refund update: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// WalletCrediter is the slice of wallet.Service this package needs to credit
// refunds back to a closed-loop wallet. Defined as an interface to keep
// internal/wallet from being imported here (avoids the cycle and lets the
// adapter live in main).
type WalletCrediter interface {
	Credit(
		ctx context.Context,
		userID string,
		amountPaise int64,
		kind string,
		paymentID, bookingID *string,
		note string,
	) error
}

type Handler struct {
	repo       *Repository
	recorder   *audit.Recorder
	dispatcher *webhooks.Dispatcher
	gateway    payments.Gateway
	notif      *notification.Service
	wallet     WalletCrediter
}

func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	// Default to manual gateway so the handler is safe to call even before
	// SetGateway is invoked from main.
	return &Handler{repo: repo, recorder: recorder, gateway: &payments.ManualGateway{}}
}

// SetDispatcher wires the outbound webhook dispatcher.
func (h *Handler) SetDispatcher(d *webhooks.Dispatcher) { h.dispatcher = d }

// SetGateway swaps the active payment gateway. Called from cmd/crm-api/main.go
// after config detection picks Cashfree vs the manual fallback.
func (h *Handler) SetGateway(g payments.Gateway) {
	if g != nil {
		h.gateway = g
	}
}

// SetNotification wires the FCM notification service for refund-processed
// customer pings. Optional — refund processing succeeds without it.
func (h *Handler) SetNotification(n *notification.Service) { h.notif = n }

// SetWallet wires the wallet service so refunds against wallet-paid bookings
// are credited back to the user's closed-loop wallet instead of being routed
// to the Cashfree refund API. Optional — without it, wallet-paid refunds
// fall back to manual.
func (h *Handler) SetWallet(w WalletCrediter) { h.wallet = w }

func (h *Handler) fireWebhook(ctx context.Context, event string, payload any) {
	if h.dispatcher == nil {
		return
	}
	h.dispatcher.Dispatch(ctx, event, payload)
}

func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/refunds")
	read := middleware.RequirePermission("refunds.read")
	g.Get("/", read, h.List)
	g.Get("/:id", read, h.Get)
	g.Post("/:id/approve", middleware.RequirePermission("refunds.approve_full"), h.Approve)
	g.Post("/:id/reject", middleware.RequirePermission("refunds.reject"), h.Reject)
	g.Post("/:id/retry", middleware.RequirePermission("refunds.approve_full"), h.Retry)
	g.Post("/from-order/:orderId", middleware.RequirePermission("refunds.approve_full"), h.CreateFromOrder)
}

func (h *Handler) List(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	items, total, err := h.repo.List(c.UserContext(), c.Query("status"), limit, offset)
	if err != nil {
		log.Error().Err(err).Msg("[crm.refunds] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": items, "total_count": total, "limit": limit, "offset": offset})
}

func (h *Handler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	out, err := h.repo.Get(c.UserContext(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "refund not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	// Audit single-refund PII reads (audit NEW-A1-002 partial).
	h.audit(c, "refund.view", id, nil, nil)
	return c.JSON(out)
}

// Approve runs the gateway call and writes the resulting status. See package
// doc for the state machine. Returns:
//   - 200 with {status, gateway_refund_id} on success or manual fallback
//   - 400 on validation / duplicate
//   - 502 on gateway error (row stored as gateway_error so admin can /retry)
func (h *Handler) Approve(c *fiber.Ctx) error {
	var req DecisionRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")

	current, err := h.repo.Get(c.UserContext(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "refund not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	if current.Status != "pending" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": fmt.Sprintf("refund is %s, not pending", current.Status)})
	}

	// Partial-refund permission gate (T1.1).
	if req.AmountCents != nil && *req.AmountCents < current.AmountCents {
		role, _ := c.Locals("crmAdminRole").(string)
		if !auth.HasPermission(role, "refunds.approve_partial") {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error":         "insufficient_permissions",
				"required_role": auth.MinRoleFor("refunds.approve_partial"),
				"your_role":     role,
			})
		}
	}

	refundAmount := current.AmountCents
	if req.AmountCents != nil {
		refundAmount = *req.AmountCents
	}
	if refundAmount <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "refund amount must be greater than zero"})
	}
	if refundAmount > current.AmountCents {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "partial amount exceeds original"})
	}

	meta, err := h.repo.resolveBookingMeta(c.UserContext(), id)
	if err != nil {
		log.Error().Err(err).Str("refund_id", id).Msg("[crm.refunds] booking-meta load failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	// Duplicate guard. Falls through silently when there's no booking_id —
	// the unique index is only defined for booking-tied rows anyway.
	if dup, when, found, derr := h.repo.findActiveRefundForBooking(c.UserContext(), meta.BookingID, id); derr == nil && found {
		msg := "refund already processed for this order"
		if !when.IsZero() {
			msg = fmt.Sprintf("refund already processed for this order on %s", when.UTC().Format("2006-01-02"))
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": msg, "duplicate_refund_id": dup})
	}

	adminID, _ := c.Locals("crmAdminID").(string)

	// Atomic flip 'pending' → 'approved'. The CAS is the lock: only one
	// concurrent caller wins and proceeds to the gateway. See lockForApproval
	// for the audit-B1-1 background.
	if err := h.repo.lockForApproval(c.UserContext(), id, []string{"pending"}); err != nil {
		if errors.Is(err, ErrAlreadyClaimed) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "refund already in progress or settled"})
		}
		log.Error().Err(err).Str("refund_id", id).Msg("[crm.refunds] lock for approval failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	processed, status, gatewayRefundID, errMsg, httpErr := h.runGateway(c.UserContext(), id, meta, refundAmount, current.UserID, req.Reason)
	if httpErr != nil {
		// Roll the lock forward to gateway_error so /retry can recover. The
		// row is now in 'approved' (the lock state), so allowedPrior is
		// ["approved"] — not ["pending"] as it was before the lock fix.
		now := time.Now().UTC()
		if rollbackErr := h.repo.approveUpdate(c.UserContext(), id, "gateway_error", "", errMsg, adminID,
			meta.PaymentMethod, meta.PaymentID, refundAmount, &now,
			[]string{"approved"}); rollbackErr != nil {
			// Audit B2-02: the rollback DB write itself failed. Gateway
			// already errored (no money moved) BUT the row is now wedged
			// in the 'approved' lock state and /retry expects
			// 'gateway_error' — manual reconciliation required.
			log.Error().
				Err(rollbackErr).
				Str("refund_id", id).
				Str("phase", "gateway_error_rollback_db_write_failed").
				Str("original_gateway_error", errMsg).
				Msg("[crm.refunds] CRITICAL: gateway failed and rollback to gateway_error also failed; refund row wedged in 'approved'; /retry will reject; manual reconciliation required")
			h.audit(c, "refund.gateway_error_rollback_failed", id,
				map[string]any{"status": "approved"},
				map[string]any{"intended_status": "gateway_error", "gateway_error": errMsg, "db_error": rollbackErr.Error()})
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "refund rollback failed; manual reconciliation required",
				"code":  "REFUND_ROLLBACK_FAILED",
			})
		}
		h.audit(c, "refund.gateway_error", id, nil, map[string]any{
			"amount_cents": refundAmount, "reason": req.Reason, "error": errMsg, "gateway": h.gateway.Name(),
		})
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "gateway_error", "message": errMsg})
	}

	var processedAt *time.Time
	if processed {
		now := time.Now().UTC()
		processedAt = &now
	}
	if err := h.repo.approveUpdate(c.UserContext(), id, status, gatewayRefundID, "", adminID,
		meta.PaymentMethod, meta.PaymentID, refundAmount, processedAt,
		[]string{"approved"}); err != nil {
		// CRITICAL: the gateway has already moved money but our DB row is
		// still in the 'approved' lock state. Distinguishable log for ops
		// reconciliation — generic "approve update failed" is not enough
		// (audit B2-02). 'phase' is the grep handle.
		log.Error().
			Err(err).
			Str("refund_id", id).
			Str("gateway_ref", gatewayRefundID).
			Str("status", status).
			Str("phase", "post_gateway_db_write").
			Msg("CRITICAL: refund succeeded at gateway but DB row write to final status failed — manual reconciliation required, money has moved")
		h.audit(c, "refund.post_gateway_db_write_failed", id,
			map[string]any{"status": "approved"},
			map[string]any{"intended_status": status, "gateway_ref": gatewayRefundID, "db_error": err.Error()})
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	h.audit(c, "refund.approve", id, nil, map[string]any{
		"amount_cents": refundAmount, "reason": req.Reason, "status": status, "gateway": h.gateway.Name(),
	})

	now := time.Now().UTC()
	h.fireWebhook(c.UserContext(), webhooks.EventRefundApproved, webhooks.RefundApprovedEvent{
		RefundID:    id,
		UserID:      current.UserID,
		AmountCents: refundAmount,
		AdminID:     adminID,
		OccurredAt:  now,
	})
	if status == "processed" || status == "processed_manual" {
		h.fireWebhook(c.UserContext(), webhooks.EventRefundProcessed, webhooks.RefundProcessedEvent{
			RefundID:        id,
			BookingID:       meta.BookingID,
			UserID:          current.UserID,
			AmountCents:     refundAmount,
			PaymentMethod:   meta.PaymentMethod,
			GatewayRefundID: gatewayRefundID,
			Manual:          status == "processed_manual",
			AdminID:         adminID,
			OccurredAt:      now,
		})
		h.notifyCustomer(c.UserContext(), current.UserID, refundAmount, meta.BookingID)
	}

	return c.JSON(fiber.Map{
		"ok":                true,
		"status":            status,
		"gateway_refund_id": gatewayRefundID,
	})
}

// Retry re-runs the gateway call for a row stuck in 'gateway_error'. Only the
// refunds.approve_full role can drive this — partial-amount semantics are
// already locked in from the original Approve.
func (h *Handler) Retry(c *fiber.Ctx) error {
	id := c.Params("id")
	current, err := h.repo.Get(c.UserContext(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "refund not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	if current.Status != "gateway_error" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": fmt.Sprintf("refund is %s, retry only valid for gateway_error", current.Status)})
	}

	meta, err := h.repo.resolveBookingMeta(c.UserContext(), id)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	adminID, _ := c.Locals("crmAdminID").(string)
	refundAmount := current.AmountCents

	// Atomic flip 'gateway_error' → 'approved'. Same lock-before-call pattern
	// as Approve — two concurrent Retry clicks would otherwise both fire the
	// gateway against a row Cashfree may already be processing (audit B1-1).
	if err := h.repo.lockForApproval(c.UserContext(), id, []string{"gateway_error"}); err != nil {
		if errors.Is(err, ErrAlreadyClaimed) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "refund already in progress or settled"})
		}
		log.Error().Err(err).Str("refund_id", id).Msg("[crm.refunds] lock for retry failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	processed, status, gatewayRefundID, errMsg, httpErr := h.runGateway(c.UserContext(), id, meta, refundAmount, current.UserID, "retry")
	if httpErr != nil {
		now := time.Now().UTC()
		if rollbackErr := h.repo.approveUpdate(c.UserContext(), id, "gateway_error", "", errMsg, adminID,
			meta.PaymentMethod, meta.PaymentID, refundAmount, &now,
			[]string{"approved"}); rollbackErr != nil {
			log.Error().
				Err(rollbackErr).
				Str("refund_id", id).
				Str("phase", "gateway_error_rollback_db_write_failed").
				Str("original_gateway_error", errMsg).
				Msg("[crm.refunds] CRITICAL: retry gateway failed and rollback to gateway_error also failed; refund row wedged in 'approved'; subsequent /retry will reject; manual reconciliation required")
			h.audit(c, "refund.gateway_error_rollback_failed", id,
				map[string]any{"status": "approved"},
				map[string]any{"intended_status": "gateway_error", "gateway_error": errMsg, "db_error": rollbackErr.Error()})
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "refund rollback failed; manual reconciliation required",
				"code":  "REFUND_ROLLBACK_FAILED",
			})
		}
		h.audit(c, "refund.retry_failed", id, nil, map[string]any{"error": errMsg, "gateway": h.gateway.Name()})
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "gateway_error", "message": errMsg})
	}

	var processedAt *time.Time
	if processed {
		now := time.Now().UTC()
		processedAt = &now
	}
	if err := h.repo.approveUpdate(c.UserContext(), id, status, gatewayRefundID, "", adminID,
		meta.PaymentMethod, meta.PaymentID, refundAmount, processedAt,
		[]string{"approved"}); err != nil {
		log.Error().
			Err(err).
			Str("refund_id", id).
			Str("gateway_ref", gatewayRefundID).
			Str("status", status).
			Str("phase", "post_gateway_db_write").
			Msg("CRITICAL: refund retry succeeded at gateway but DB row write to final status failed — manual reconciliation required, money has moved")
		h.audit(c, "refund.post_gateway_db_write_failed", id,
			map[string]any{"status": "approved"},
			map[string]any{"intended_status": status, "gateway_ref": gatewayRefundID, "db_error": err.Error()})
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	h.audit(c, "refund.retry", id, nil, map[string]any{"status": status, "gateway": h.gateway.Name()})
	now := time.Now().UTC()
	if status == "processed" || status == "processed_manual" {
		h.fireWebhook(c.UserContext(), webhooks.EventRefundProcessed, webhooks.RefundProcessedEvent{
			RefundID:        id,
			BookingID:       meta.BookingID,
			UserID:          current.UserID,
			AmountCents:     refundAmount,
			PaymentMethod:   meta.PaymentMethod,
			GatewayRefundID: gatewayRefundID,
			Manual:          status == "processed_manual",
			AdminID:         adminID,
			OccurredAt:      now,
		})
		h.notifyCustomer(c.UserContext(), current.UserID, refundAmount, meta.BookingID)
	}

	return c.JSON(fiber.Map{
		"ok":                true,
		"status":            status,
		"gateway_refund_id": gatewayRefundID,
	})
}

// runGateway is the shared "call the gateway and translate the outcome"
// helper used by both Approve and Retry. Returns:
//
//	processed      — whether to set processed_at
//	status         — the new pending_refunds.status value
//	gatewayRefundID— gateway-side reference (empty for manual)
//	errMsg         — populated when httpErr != nil
//	httpErr        — non-nil when the caller should respond 502
//
// refundID is the merchant refund row UUID, plumbed through to the gateway
// as its idempotency key — Cashfree uses it as the body's refund_id, so a
// resubmission of the same refundID returns the existing refund record
// rather than triggering a second money movement (audit B5-D4 / D4-N8).
// Callers MUST hold the row-level CAS lock from lockForApproval before
// invoking this; the gateway-side dedup is defense in depth, not the
// primary protection against TOCTOU.
func (h *Handler) runGateway(ctx context.Context, refundID string, meta bookingMeta, amount int64, userID, reason string) (bool, string, string, string, error) {
	// COD always goes manual regardless of which gateway is configured —
	// there's nothing to refund through a digital channel.
	if meta.PaymentMethod == string(payments.MethodCOD) {
		return true, "processed_manual", "", "", nil
	}

	// Wallet-paid bookings refund back to the closed-loop wallet. We do NOT
	// walk back to the original Cashfree top-up here. Wallet-paid refunds
	// stay in wallet by design (closed-loop) — the alternative would require
	// PPI licensing for "withdraw to bank" flows.
	if meta.PaymentMethod == "wallet" {
		if h.wallet == nil {
			log.Warn().Str("booking_id", meta.BookingID).Msg("[crm.refunds] wallet refund needs wallet service; falling back to manual")
			return true, "processed_manual", "", "", nil
		}
		if userID == "" {
			return false, "gateway_error", "", "wallet refund: missing user_id", fmt.Errorf("wallet refund: missing user_id")
		}
		bookingID := meta.BookingID
		var bookingPtr *string
		if bookingID != "" {
			bookingPtr = &bookingID
		}
		note := "Refund"
		if reason != "" {
			note = "Refund: " + reason
		}
		if err := h.wallet.Credit(ctx, userID, amount, "refund_credit", nil, bookingPtr, note); err != nil {
			return false, "gateway_error", "", err.Error(), err
		}
		// "wallet" gateway-refund-id keeps the audit trail honest — there's
		// no external reference, but the column should not be empty since
		// processed_manual is reserved for ops-settled paths.
		return true, "processed", "wallet:" + meta.BookingID, "", nil
	}

	// No payment_id means we have no gateway anchor; the only thing we can
	// do is mark it manual so ops handles it.
	if meta.PaymentID == "" {
		return true, "processed_manual", "", "", nil
	}

	gw := h.gateway
	if gw == nil {
		gw = &payments.ManualGateway{}
	}
	result, err := gw.Refund(ctx, meta.PaymentID, amount, payments.PaymentMethod(meta.PaymentMethod), refundID)
	if errors.Is(err, payments.ErrUnsupportedMethod) {
		return true, "processed_manual", "", "", nil
	}
	if err != nil {
		return false, "gateway_error", "", err.Error(), err
	}
	if result == nil {
		return true, "processed_manual", "", "", nil
	}
	if result.Manual {
		return true, "processed_manual", "", "", nil
	}
	return true, "processed", result.GatewayRefundID, "", nil
}

// notifyCustomer is best-effort: failures are logged and swallowed.
func (h *Handler) notifyCustomer(_ context.Context, userID string, amountCents int64, bookingID string) {
	if h.notif == nil || userID == "" {
		return
	}
	go func(ctx context.Context, userID string, cents int64, bid string) {
		// Strip cents to the nearest rupee for the human-readable amount.
		// We intentionally don't format with commas — keeps the body short.
		amount := strconv.FormatInt(cents/100, 10)
		if err := h.notif.NotifyCustomerRefundProcessed(ctx, userID, amount, bid); err != nil {
			log.Warn().Err(err).Str("user_id", userID).Msg("[crm.refunds] notify customer failed")
		}
	}(context.Background(), userID, amountCents, bookingID)
}

func (h *Handler) Reject(c *fiber.Ctx) error {
	var req DecisionRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	if err := h.repo.Reject(c.UserContext(), id); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "refund.reject", id, nil, req.Reason)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "refunds",
		TargetType: "refund", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}

// bookingForRefund holds the payment context needed to seed a new
// pending_refunds row from an order id.
type bookingForRefund struct {
	UserID        string
	AmountPaise   int64
	PaymentMethod string
	PaymentID     string
}

// loadBookingForRefund fetches the customer + payment metadata from a
// booking. Returns ErrNotFound when the booking is missing.
func (r *Repository) loadBookingForRefund(ctx context.Context, bookingID string) (*bookingForRefund, error) {
	var (
		userID  string
		price   int64
		method  *string
		payID   *string
	)
	err := r.read.QueryRow(ctx, `
		SELECT customer_id::text, amount_paise, payment_method, payment_id
		FROM bookings WHERE id = $1::uuid
	`, bookingID).Scan(&userID, &price, &method, &payID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	out := &bookingForRefund{UserID: userID, AmountPaise: price}
	if method != nil {
		out.PaymentMethod = *method
	}
	if payID != nil {
		out.PaymentID = *payID
	}
	return out, nil
}

// CreatePendingForBooking inserts a new pending_refunds row tied to a
// booking. Returns the new refund id.
func (r *Repository) CreatePendingForBooking(
	ctx context.Context,
	bookingID, userID, paymentMethod, paymentID string,
	amountCents int64,
) (string, error) {
	var id string
	err := r.write.QueryRow(ctx, `
		INSERT INTO pending_refunds (
			user_id, amount_cents, source, source_ref, status,
			booking_id, payment_method, payment_id
		)
		VALUES (
			$1::uuid, $2, 'manual_crm', $3, 'pending',
			$3::uuid, NULLIF($4, ''), NULLIF($5, '')
		)
		RETURNING id::text
	`, userID, amountCents, bookingID, paymentMethod, paymentID).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("insert pending_refund: %w", err)
	}
	return id, nil
}

// CreateFromOrder creates a brand-new pending_refunds row for the given
// booking and immediately runs the gateway. Mirrors the Approve flow but
// without requiring an existing pending row.
//
// Body: { amount_cents (required, > 0), reason (required) }
func (h *Handler) CreateFromOrder(c *fiber.Ctx) error {
	orderID := c.Params("orderId")
	if orderID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "order id required"})
	}

	var req DecisionRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	if req.AmountCents == nil || *req.AmountCents <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "amount_cents must be greater than zero"})
	}
	amount := *req.AmountCents

	booking, err := h.repo.loadBookingForRefund(c.UserContext(), orderID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "order not found"})
		}
		log.Error().Err(err).Str("order_id", orderID).Msg("[crm.refunds] load booking failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	if amount > booking.AmountPaise {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "amount exceeds order total"})
	}

	// Partial-refund permission gate (matches Approve).
	if amount < booking.AmountPaise {
		role, _ := c.Locals("crmAdminRole").(string)
		if !auth.HasPermission(role, "refunds.approve_partial") {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error":         "insufficient_permissions",
				"required_role": auth.MinRoleFor("refunds.approve_partial"),
				"your_role":     role,
			})
		}
	}

	// Duplicate guard: if there's already an active refund row tied to this
	// booking, reject before inserting another.
	if dup, when, found, derr := h.repo.findActiveRefundForBooking(c.UserContext(), orderID, "00000000-0000-0000-0000-000000000000"); derr == nil && found {
		msg := "refund already processed for this order"
		if !when.IsZero() {
			msg = fmt.Sprintf("refund already processed for this order on %s", when.UTC().Format("2006-01-02"))
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": msg, "duplicate_refund_id": dup})
	}

	refundID, err := h.repo.CreatePendingForBooking(c.UserContext(), orderID,
		booking.UserID, booking.PaymentMethod, booking.PaymentID, amount)
	if err != nil {
		log.Error().Err(err).Str("order_id", orderID).Msg("[crm.refunds] create pending failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	meta := bookingMeta{
		BookingID:     orderID,
		PaymentMethod: booking.PaymentMethod,
		PaymentID:     booking.PaymentID,
	}
	adminID, _ := c.Locals("crmAdminID").(string)

	processed, status, gatewayRefundID, errMsg, httpErr := h.runGateway(c.UserContext(), refundID, meta, amount, booking.UserID, req.Reason)
	if httpErr != nil {
		now := time.Now().UTC()
		if rollbackErr := h.repo.approveUpdate(c.UserContext(), refundID, "gateway_error", "", errMsg, adminID,
			meta.PaymentMethod, meta.PaymentID, amount, &now,
			[]string{"pending"}); rollbackErr != nil {
			// CreateFromOrder rollback runs from 'pending' (not the
			// lock state Approve/Retry use), so a wedged row stays
			// in 'pending' rather than 'approved'. Same operational
			// posture though — manual reconciliation, /retry can't
			// help (status mismatch).
			log.Error().
				Err(rollbackErr).
				Str("refund_id", refundID).
				Str("phase", "gateway_error_rollback_db_write_failed").
				Str("original_gateway_error", errMsg).
				Msg("[crm.refunds] CRITICAL: manual-create gateway failed and rollback to gateway_error also failed; refund row wedged in 'pending'; manual reconciliation required")
			h.audit(c, "refund.gateway_error_rollback_failed", refundID,
				map[string]any{"status": "pending"},
				map[string]any{"intended_status": "gateway_error", "gateway_error": errMsg, "db_error": rollbackErr.Error()})
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "refund rollback failed; manual reconciliation required",
				"code":  "REFUND_ROLLBACK_FAILED",
			})
		}
		h.audit(c, "refund.manual_gateway_error", refundID, nil, map[string]any{
			"order_id": orderID, "amount_cents": amount, "reason": req.Reason,
			"error": errMsg, "gateway": h.gateway.Name(),
		})
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{
			"error": "gateway_error", "message": errMsg, "refund_id": refundID,
		})
	}

	var processedAt *time.Time
	if processed {
		now := time.Now().UTC()
		processedAt = &now
	}
	if err := h.repo.approveUpdate(c.UserContext(), refundID, status, gatewayRefundID, "", adminID,
		meta.PaymentMethod, meta.PaymentID, amount, processedAt,
		[]string{"pending"}); err != nil {
		// CRITICAL: gateway moved money but DB write failed. Match the
		// Approve/Retry forensic shape so a single ops grep alert keyed
		// on phase=post_gateway_db_write catches all three handlers.
		log.Error().
			Err(err).
			Str("refund_id", refundID).
			Str("gateway_ref", gatewayRefundID).
			Str("status", status).
			Str("phase", "post_gateway_db_write").
			Msg("CRITICAL: manual-create refund succeeded at gateway but DB row write to final status failed — manual reconciliation required, money has moved")
		h.audit(c, "refund.post_gateway_db_write_failed", refundID,
			map[string]any{"status": "pending"},
			map[string]any{"intended_status": status, "gateway_ref": gatewayRefundID, "db_error": err.Error()})
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	h.audit(c, "refund.manual_create", refundID, nil, map[string]any{
		"order_id": orderID, "amount_cents": amount, "reason": req.Reason,
		"status": status, "gateway": h.gateway.Name(),
	})

	now := time.Now().UTC()
	h.fireWebhook(c.UserContext(), webhooks.EventRefundApproved, webhooks.RefundApprovedEvent{
		RefundID:    refundID,
		UserID:      booking.UserID,
		AmountCents: amount,
		AdminID:     adminID,
		OccurredAt:  now,
	})
	if status == "processed" || status == "processed_manual" {
		h.fireWebhook(c.UserContext(), webhooks.EventRefundProcessed, webhooks.RefundProcessedEvent{
			RefundID:        refundID,
			BookingID:       orderID,
			UserID:          booking.UserID,
			AmountCents:     amount,
			PaymentMethod:   meta.PaymentMethod,
			GatewayRefundID: gatewayRefundID,
			Manual:          status == "processed_manual",
			AdminID:         adminID,
			OccurredAt:      now,
		})
		h.notifyCustomer(c.UserContext(), booking.UserID, amount, orderID)
	}

	return c.JSON(fiber.Map{
		"ok":                true,
		"refund_id":         refundID,
		"status":            status,
		"gateway_refund_id": gatewayRefundID,
	})
}
