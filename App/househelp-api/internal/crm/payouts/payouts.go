// Package payouts manages crm_payouts. Mark-paid is admin-driven; the
// actual bank/UPI transfer is out of scope (no provider wired). Marking a
// row paid records intent + audit; a separate worker would dispatch.
package payouts

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

type Payout struct {
	ID          string     `json:"id"`
	WorkerID    string     `json:"worker_id"`
	WorkerName  *string    `json:"worker_name,omitempty"`
	WorkerPhone string     `json:"worker_phone"`
	PeriodStart time.Time  `json:"period_start"`
	PeriodEnd   time.Time  `json:"period_end"`
	AmountCents int64      `json:"amount_cents"`
	Status      string     `json:"status"`
	PaidAt      *time.Time `json:"paid_at,omitempty"`
	ExternalRef *string    `json:"external_ref,omitempty"`
	Notes       *string    `json:"notes,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

type CreateRequest struct {
	WorkerID    string    `json:"worker_id"`
	PeriodStart time.Time `json:"period_start"`
	PeriodEnd   time.Time `json:"period_end"`
	AmountCents int64     `json:"amount_cents"`
	Notes       string    `json:"notes"`
}

type Repository struct{ read, write *pgxpool.Pool }

func NewRepository(read, write *pgxpool.Pool) *Repository { return &Repository{read: read, write: write} }

func (r *Repository) List(ctx context.Context, status string, limit, offset int) ([]Payout, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	args := []any{}
	cond := ""
	if status != "" {
		args = append(args, status)
		cond = "WHERE p.status = $1"
	}
	args = append(args, limit, offset)
	limitParam, offsetParam := len(args)-1, len(args)
	rows, err := r.read.Query(ctx, fmt.Sprintf(`
		SELECT p.id::text, p.worker_id::text, u.name, u.phone,
		       p.period_start, p.period_end, p.amount_cents, p.status,
		       p.paid_at, p.external_ref, p.notes, p.created_at
		FROM crm_payouts p
		JOIN users u ON u.id = p.worker_id
		%s
		ORDER BY p.created_at DESC
		LIMIT $%d OFFSET $%d
	`, cond, limitParam, offsetParam), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list payouts: %w", err)
	}
	defer rows.Close()
	out := []Payout{}
	for rows.Next() {
		var p Payout
		if err := rows.Scan(&p.ID, &p.WorkerID, &p.WorkerName, &p.WorkerPhone,
			&p.PeriodStart, &p.PeriodEnd, &p.AmountCents, &p.Status,
			&p.PaidAt, &p.ExternalRef, &p.Notes, &p.CreatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, p)
	}
	countArgs := args[:len(args)-2]
	countSQL := fmt.Sprintf(`SELECT COUNT(*) FROM crm_payouts p %s`, cond)
	var total int
	if err := r.read.QueryRow(ctx, countSQL, countArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

func (r *Repository) Create(ctx context.Context, req CreateRequest) (string, error) {
	if req.AmountCents <= 0 {
		return "", errors.New("amount_cents must be > 0")
	}
	id := ""
	err := r.write.QueryRow(ctx, `
		INSERT INTO crm_payouts (worker_id, period_start, period_end, amount_cents, notes)
		VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''))
		RETURNING id::text
	`, req.WorkerID, req.PeriodStart, req.PeriodEnd, req.AmountCents, req.Notes).Scan(&id)
	return id, err
}

func (r *Repository) MarkPaid(ctx context.Context, id, externalRef string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE crm_payouts
		SET status='paid', paid_at=now(), external_ref=NULLIF($2, ''), updated_at=now()
		WHERE id = $1::uuid AND status IN ('pending','processing')
	`, id, externalRef)
	if err != nil || res.RowsAffected() == 0 {
		return fmt.Errorf("mark paid: %w", err)
	}
	return nil
}

func (r *Repository) MarkFailed(ctx context.Context, id, notes string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE crm_payouts SET status='failed', notes=NULLIF($2, ''), updated_at=now()
		WHERE id = $1::uuid
	`, id, notes)
	if err != nil || res.RowsAffected() == 0 {
		return fmt.Errorf("mark failed: %w", err)
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
	g := r.Group("/payouts")
	g.Get("/",            middleware.RequirePermission("payouts.read"), h.List)
	g.Post("/",           middleware.RequirePermission("payouts.create"), h.Create)
	g.Post("/:id/paid",   middleware.RequirePermission("payouts.mark_paid"), h.MarkPaid)
	g.Post("/:id/failed", middleware.RequirePermission("payouts.mark_failed"), h.MarkFailed)
}

func (h *Handler) List(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	items, total, err := h.repo.List(c.UserContext(), c.Query("status"), limit, offset)
	if err != nil {
		log.Error().Err(err).Msg("[crm.payouts] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": items, "total_count": total, "limit": limit, "offset": offset})
}

func (h *Handler) Create(c *fiber.Ctx) error {
	var req CreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	id, err := h.repo.Create(c.UserContext(), req)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "payout.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) MarkPaid(c *fiber.Ctx) error {
	var body struct{ ExternalRef string `json:"external_ref"` }
	_ = c.BodyParser(&body)
	id := c.Params("id")
	if err := h.repo.MarkPaid(c.UserContext(), id, body.ExternalRef); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "payout.paid", id, nil, body.ExternalRef)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) MarkFailed(c *fiber.Ctx) error {
	var body struct{ Notes string `json:"notes"` }
	_ = c.BodyParser(&body)
	id := c.Params("id")
	if err := h.repo.MarkFailed(c.UserContext(), id, body.Notes); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "payout.failed", id, nil, body.Notes)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "payouts",
		TargetType: "payout", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}
