// Package orders is the CRM-side surface for booking lifecycle management.
// Reads happen on the read pool, mutations on the write pool. The package
// never reaches into matching/booking business logic — it only annotates
// existing rows on bookings + writes to crm_audit_log.
package orders

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

var ErrNotFound = errors.New("order not found")

// ── Models ─────────────────────────────────────────────────────────────

// ListItem is a row in the orders table.
type ListItem struct {
	ID             string     `json:"id"`
	CustomerName   *string    `json:"customer_name,omitempty"`
	CustomerPhone  string     `json:"customer_phone"`
	WorkerName     *string    `json:"worker_name,omitempty"`
	WorkerPhone    *string    `json:"worker_phone,omitempty"`
	Category       string     `json:"category"`
	Status         string     `json:"status"`
	PriceCents     int        `json:"price_cents"`
	DiscountCents  int        `json:"discount_cents"`
	PromoCode      *string    `json:"promo_code,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	CompletedAt    *time.Time `json:"completed_at,omitempty"`
}

// Detail is the per-order drawer payload, including the timeline.
type Detail struct {
	ListItem
	CustomerID    string     `json:"customer_id"`
	WorkerID      *string    `json:"worker_id,omitempty"`
	Address       string     `json:"address"`
	Lat           float64    `json:"lat"`
	Lng           float64    `json:"lng"`
	ScheduledTime *time.Time `json:"scheduled_time,omitempty"`
	MatchedAt     *time.Time `json:"matched_at,omitempty"`
	AcceptedAt    *time.Time `json:"accepted_at,omitempty"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	ArrivedAt     *time.Time `json:"arrived_at,omitempty"`
	CancelledAt   *time.Time `json:"cancelled_at,omitempty"`
	CancelledBy   *string    `json:"cancelled_by,omitempty"`
}

// CancelRequest is the body of POST /orders/:id/cancel.
type CancelRequest struct {
	Reason string `json:"reason" validate:"required,min=2,max=500"`
}

// ── Repository ─────────────────────────────────────────────────────────

// Repository wraps DB access for the orders module.
type Repository struct{ read, write *pgxpool.Pool }

// NewRepository constructs a Repository.
func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

// List returns a page of orders matching the filter.
func (r *Repository) List(ctx context.Context, search, status, category, customerID, workerID string, fromTS, toTS *time.Time, minCents, maxCents *int, sortBy, sortDir string, limit, offset int) ([]ListItem, int, error) {
	args := []any{}
	conds := []string{"1=1"}
	if search != "" {
		args = append(args, "%"+strings.ToLower(search)+"%")
		i := len(args)
		conds = append(conds, fmt.Sprintf(
			"(LOWER(b.id::text) LIKE $%d OR LOWER(cu.name) LIKE $%d OR LOWER(cu.phone) LIKE $%d OR LOWER(hu.name) LIKE $%d)",
			i, i, i, i,
		))
	}
	if status != "" {
		args = append(args, status)
		conds = append(conds, fmt.Sprintf("b.status = $%d", len(args)))
	}
	if category != "" {
		args = append(args, category)
		conds = append(conds, fmt.Sprintf("LOWER(sc.name) = LOWER($%d)", len(args)))
	}
	if customerID != "" {
		args = append(args, customerID)
		conds = append(conds, fmt.Sprintf("b.customer_id = $%d::uuid", len(args)))
	}
	if workerID != "" {
		args = append(args, workerID)
		conds = append(conds, fmt.Sprintf("b.helper_id = $%d::uuid", len(args)))
	}
	if fromTS != nil {
		args = append(args, *fromTS)
		conds = append(conds, fmt.Sprintf("b.created_at >= $%d", len(args)))
	}
	if toTS != nil {
		args = append(args, *toTS)
		conds = append(conds, fmt.Sprintf("b.created_at <= $%d", len(args)))
	}
	if minCents != nil {
		args = append(args, *minCents)
		conds = append(conds, fmt.Sprintf("b.price_cents >= $%d", len(args)))
	}
	if maxCents != nil {
		args = append(args, *maxCents)
		conds = append(conds, fmt.Sprintf("b.price_cents <= $%d", len(args)))
	}

	sortColMap := map[string]string{"": "b.created_at", "created_at": "b.created_at", "price": "b.price_cents", "status": "b.status"}
	sortCol, ok := sortColMap[sortBy]
	if !ok {
		sortCol = "b.created_at"
	}
	sortDirN := strings.ToUpper(strings.TrimSpace(sortDir))
	if sortDirN != "ASC" {
		sortDirN = "DESC"
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}

	whereSQL := "WHERE " + strings.Join(conds, " AND ")
	args = append(args, limit, offset)
	limitParam, offsetParam := len(args)-1, len(args)

	pageSQL := fmt.Sprintf(`
		SELECT b.id::text, cu.name, cu.phone, hu.name, hu.phone,
		       COALESCE(sc.name, '—'),
		       b.status, b.price_cents, b.discount_cents, b.promo_code,
		       b.created_at, b.completed_at
		FROM bookings b
		JOIN users cu ON cu.id = b.customer_id
		LEFT JOIN users hu ON hu.id = b.helper_id
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		%s
		ORDER BY %s %s
		LIMIT $%d OFFSET $%d
	`, whereSQL, sortCol, sortDirN, limitParam, offsetParam)

	rows, err := r.read.Query(ctx, pageSQL, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list orders: %w", err)
	}
	defer rows.Close()

	items := []ListItem{}
	for rows.Next() {
		var it ListItem
		if err := rows.Scan(
			&it.ID, &it.CustomerName, &it.CustomerPhone, &it.WorkerName, &it.WorkerPhone,
			&it.Category, &it.Status, &it.PriceCents, &it.DiscountCents, &it.PromoCode,
			&it.CreatedAt, &it.CompletedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scan order: %w", err)
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	countArgs := args[:len(args)-2]
	countSQL := fmt.Sprintf(`
		SELECT COUNT(*) FROM bookings b
		JOIN users cu ON cu.id = b.customer_id
		LEFT JOIN users hu ON hu.id = b.helper_id
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		%s
	`, whereSQL)
	var total int
	if err := r.read.QueryRow(ctx, countSQL, countArgs...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count orders: %w", err)
	}
	return items, total, nil
}

// Get returns the per-order detail.
func (r *Repository) Get(ctx context.Context, id string) (*Detail, error) {
	const q = `
		SELECT b.id::text, cu.name, cu.phone, hu.name, hu.phone,
		       COALESCE(sc.name, '—'),
		       b.status, b.price_cents, b.discount_cents, b.promo_code,
		       b.created_at, b.completed_at,
		       b.customer_id::text, b.helper_id::text,
		       b.address, b.lat::float8, b.lng::float8,
		       b.scheduled_time, b.matched_at, b.accepted_at,
		       b.started_at, b.arrived_at, b.cancelled_at, b.cancelled_by
		FROM bookings b
		JOIN users cu ON cu.id = b.customer_id
		LEFT JOIN users hu ON hu.id = b.helper_id
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		WHERE b.id = $1::uuid
	`
	var d Detail
	err := r.read.QueryRow(ctx, q, id).Scan(
		&d.ID, &d.CustomerName, &d.CustomerPhone, &d.WorkerName, &d.WorkerPhone,
		&d.Category, &d.Status, &d.PriceCents, &d.DiscountCents, &d.PromoCode,
		&d.CreatedAt, &d.CompletedAt,
		&d.CustomerID, &d.WorkerID,
		&d.Address, &d.Lat, &d.Lng,
		&d.ScheduledTime, &d.MatchedAt, &d.AcceptedAt,
		&d.StartedAt, &d.ArrivedAt, &d.CancelledAt, &d.CancelledBy,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get order: %w", err)
	}
	return &d, nil
}

// Cancel marks an order cancelled. Refuses to cancel completed orders —
// admins should issue a refund for those instead.
func (r *Repository) Cancel(ctx context.Context, id, reason, adminEmail string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE bookings
		SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, updated_at = now()
		WHERE id = $1::uuid AND status NOT IN ('completed','cancelled')
	`, id, "admin:"+adminEmail)
	if err != nil {
		return fmt.Errorf("cancel order: %w", err)
	}
	if res.RowsAffected() == 0 {
		return errors.New("order is completed or already cancelled")
	}
	_ = reason // captured in audit log by handler
	return nil
}

// MarkComplete forces an order into 'completed' state. Pro Mode only.
func (r *Repository) MarkComplete(ctx context.Context, id string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE bookings
		SET status = 'completed', completed_at = now(), updated_at = now()
		WHERE id = $1::uuid AND status NOT IN ('completed','cancelled')
	`, id)
	if err != nil {
		return fmt.Errorf("mark complete: %w", err)
	}
	if res.RowsAffected() == 0 {
		return errors.New("order is already completed or cancelled")
	}
	return nil
}

// ── Handler ────────────────────────────────────────────────────────────

// Handler is the HTTP layer.
type Handler struct {
	repo     *Repository
	recorder *audit.Recorder
}

// NewHandler constructs a Handler.
func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// RegisterRoutes mounts /orders/* on the authed group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/orders")
	g.Get("/",                h.List)
	g.Get("/:id",             h.Get)
	g.Post("/:id/cancel",     h.Cancel)
	g.Post("/:id/complete",   h.Complete)
}

// List handles GET /orders.
func (h *Handler) List(c *fiber.Ctx) error {
	q := c.Query
	limit, _ := strconv.Atoi(q("limit", "50"))
	offset, _ := strconv.Atoi(q("offset", "0"))

	var fromTS, toTS *time.Time
	if v := q("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			fromTS = &t
		}
	}
	if v := q("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			toTS = &t
		}
	}
	var minC, maxC *int
	if v := q("min_cents"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			minC = &n
		}
	}
	if v := q("max_cents"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			maxC = &n
		}
	}

	items, total, err := h.repo.List(c.Context(),
		q("search"), q("status"), q("category"), q("customer_id"), q("worker_id"),
		fromTS, toTS, minC, maxC, q("sort_by"), q("sort_dir"), limit, offset,
	)
	if err != nil {
		log.Error().Err(err).Msg("[crm.orders] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": items, "total_count": total, "limit": limit, "offset": offset})
}

// Get handles GET /orders/:id.
func (h *Handler) Get(c *fiber.Ctx) error {
	d, err := h.repo.Get(c.Context(), c.Params("id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "order not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(d)
}

// Cancel handles POST /orders/:id/cancel.
func (h *Handler) Cancel(c *fiber.Ctx) error {
	var req CancelRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason required"})
	}
	id := c.Params("id")
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	if err := h.repo.Cancel(c.Context(), id, req.Reason, adminEmail); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "order.cancel", id, nil, req.Reason)
	return c.JSON(fiber.Map{"ok": true})
}

// Complete handles POST /orders/:id/complete (Pro Mode only on the SPA).
func (h *Handler) Complete(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.MarkComplete(c.Context(), id); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "order.complete_manual", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.Context(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "orders",
		TargetType: "order", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}
