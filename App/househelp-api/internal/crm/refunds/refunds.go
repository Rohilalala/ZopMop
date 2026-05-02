// Package refunds wraps the existing pending_refunds table for the CRM.
// Approval / partial / rejection are admin-driven; the package does NOT
// call the payment gateway — that integration lives in the user-app's
// payments module and is invoked by the matching ledger logic.
//
// Approve here flips status='approved' and sets settled_at; the payments
// worker subsequently picks up approved rows and performs the actual
// gateway reversal (out of scope for this package).
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
)

var ErrNotFound = errors.New("refund not found")

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
		SELECT pr.id::text, pr.user_id::text, u.name, u.phone,
		       pr.amount_cents, pr.source, pr.source_ref, pr.status,
		       pr.created_at, pr.settled_at
		FROM pending_refunds pr
		JOIN users u ON u.id = pr.user_id
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
		SELECT pr.id::text, pr.user_id::text, u.name, u.phone,
		       pr.amount_cents, pr.source, pr.source_ref, pr.status,
		       pr.created_at, pr.settled_at
		FROM pending_refunds pr
		JOIN users u ON u.id = pr.user_id
		WHERE pr.id = $1::uuid
	`, id).Scan(&i.ID, &i.UserID, &i.UserName, &i.UserPhone,
		&i.AmountCents, &i.Source, &i.SourceRef, &i.Status,
		&i.CreatedAt, &i.SettledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &i, nil
}

// Approve marks the refund approved (full or partial). The actual gateway
// call is the payments worker's job; CRM just sets the desired state.
func (r *Repository) Approve(ctx context.Context, id string, amountCents *int64) error {
	current, err := r.Get(ctx, id)
	if err != nil {
		return err
	}
	if current.Status != "pending" {
		return fmt.Errorf("refund is %s, not pending", current.Status)
	}
	finalAmount := current.AmountCents
	if amountCents != nil {
		if *amountCents <= 0 || *amountCents > current.AmountCents {
			return fmt.Errorf("amount must be > 0 and <= %d", current.AmountCents)
		}
		finalAmount = *amountCents
	}
	res, err := r.write.Exec(ctx, `
		UPDATE pending_refunds
		SET status = 'approved', amount_cents = $2, settled_at = now()
		WHERE id = $1::uuid AND status = 'pending'
	`, id, finalAmount)
	if err != nil {
		return fmt.Errorf("approve refund: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
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

type Handler struct {
	repo     *Repository
	recorder *audit.Recorder
}

func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/refunds")
	g.Get("/",            h.List)
	g.Get("/:id",         h.Get)
	g.Post("/:id/approve", h.Approve)
	g.Post("/:id/reject",  h.Reject)
}

func (h *Handler) List(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	items, total, err := h.repo.List(c.Context(), c.Query("status"), limit, offset)
	if err != nil {
		log.Error().Err(err).Msg("[crm.refunds] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": items, "total_count": total, "limit": limit, "offset": offset})
}

func (h *Handler) Get(c *fiber.Ctx) error {
	out, err := h.repo.Get(c.Context(), c.Params("id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "refund not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
}

func (h *Handler) Approve(c *fiber.Ctx) error {
	var req DecisionRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	if err := h.repo.Approve(c.Context(), id, req.AmountCents); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "refund.approve", id, nil, map[string]any{"amount_cents": req.AmountCents, "reason": req.Reason})
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) Reject(c *fiber.Ctx) error {
	var req DecisionRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	if err := h.repo.Reject(c.Context(), id); err != nil {
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
	h.recorder.Log(c.Context(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "refunds",
		TargetType: "refund", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}
