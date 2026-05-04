// Package promos manages the promotions table from the CRM. The user-app
// validates promo codes at booking time directly against this table; CRM
// only writes definitions and reads aggregated redemption stats.
package promos

import (
	"context"
	"crypto/rand"
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
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
)

var ErrNotFound = errors.New("promo not found")

type Promo struct {
	ID              string     `json:"id"`
	Code            string     `json:"code"`
	Name            *string    `json:"name,omitempty"`
	Description     *string    `json:"description,omitempty"`
	DiscountType    string     `json:"discount_type"`     // "percent" | "fixed"
	DiscountValue   int        `json:"discount_value"`
	MinOrderCents   int        `json:"min_order_cents"`
	MaxUses         int        `json:"max_uses"`          // 0 = unlimited
	UsesCount       int        `json:"uses_count"`
	MaxPerUser      int        `json:"max_per_user"`
	IsActive        bool       `json:"is_active"`
	StartsAt        *time.Time `json:"starts_at,omitempty"`
	ExpiresAt       *time.Time `json:"expires_at,omitempty"`
	Audience        string     `json:"audience"`
	AudienceUserIDs []string   `json:"audience_user_ids"`
	Categories      []string   `json:"categories"`
	Stackable       bool       `json:"stackable"`
	CreatedAt       time.Time  `json:"created_at"`
}

type CreateRequest struct {
	Code            string     `json:"code"`
	Name            string     `json:"name"`
	Description     string     `json:"description"`
	DiscountType    string     `json:"discount_type"`
	DiscountValue   int        `json:"discount_value"`
	MinOrderCents   int        `json:"min_order_cents"`
	MaxUses         int        `json:"max_uses"`
	MaxPerUser      int        `json:"max_per_user"`
	Audience        string     `json:"audience"`
	AudienceUserIDs []string   `json:"audience_user_ids"`
	Categories      []string   `json:"categories"`
	Stackable       bool       `json:"stackable"`
	StartsAt        *time.Time `json:"starts_at"`
	ExpiresAt       *time.Time `json:"expires_at"`
}

type Repository struct{ read, write *pgxpool.Pool }

func NewRepository(read, write *pgxpool.Pool) *Repository { return &Repository{read: read, write: write} }

func (r *Repository) List(ctx context.Context, search, status string, limit, offset int) ([]Promo, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	args := []any{}
	conds := []string{"1=1"}
	if search != "" {
		args = append(args, "%"+strings.ToUpper(search)+"%")
		conds = append(conds, fmt.Sprintf("UPPER(code) LIKE $%d", len(args)))
	}
	switch status {
	case "active":
		conds = append(conds, "is_active = TRUE AND (expires_at IS NULL OR expires_at > now())")
	case "expired":
		conds = append(conds, "expires_at IS NOT NULL AND expires_at <= now()")
	case "inactive":
		conds = append(conds, "is_active = FALSE")
	}
	whereSQL := "WHERE " + strings.Join(conds, " AND ")
	args = append(args, limit, offset)
	limitParam, offsetParam := len(args)-1, len(args)
	rows, err := r.read.Query(ctx, fmt.Sprintf(`
		SELECT id::text, code, name, description, discount_type, discount_value,
		       min_order_cents, max_uses, uses_count, max_per_user, is_active,
		       starts_at, expires_at, audience, audience_user_ids, categories,
		       stackable, created_at
		FROM promotions
		%s
		ORDER BY created_at DESC
		LIMIT $%d OFFSET $%d
	`, whereSQL, limitParam, offsetParam), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list promos: %w", err)
	}
	defer rows.Close()
	out := []Promo{}
	for rows.Next() {
		var p Promo
		var userIDs []string
		if err := rows.Scan(&p.ID, &p.Code, &p.Name, &p.Description, &p.DiscountType, &p.DiscountValue,
			&p.MinOrderCents, &p.MaxUses, &p.UsesCount, &p.MaxPerUser, &p.IsActive,
			&p.StartsAt, &p.ExpiresAt, &p.Audience, &userIDs, &p.Categories,
			&p.Stackable, &p.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("scan promo: %w", err)
		}
		p.AudienceUserIDs = userIDs
		out = append(out, p)
	}

	countArgs := args[:len(args)-2]
	var total int
	if err := r.read.QueryRow(ctx,
		fmt.Sprintf(`SELECT COUNT(*) FROM promotions %s`, whereSQL), countArgs...,
	).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count promos: %w", err)
	}
	return out, total, nil
}

func (r *Repository) Get(ctx context.Context, id string) (*Promo, error) {
	var p Promo
	var userIDs []string
	err := r.read.QueryRow(ctx, `
		SELECT id::text, code, name, description, discount_type, discount_value,
		       min_order_cents, max_uses, uses_count, max_per_user, is_active,
		       starts_at, expires_at, audience, audience_user_ids, categories,
		       stackable, created_at
		FROM promotions WHERE id = $1::uuid
	`, id).Scan(&p.ID, &p.Code, &p.Name, &p.Description, &p.DiscountType, &p.DiscountValue,
		&p.MinOrderCents, &p.MaxUses, &p.UsesCount, &p.MaxPerUser, &p.IsActive,
		&p.StartsAt, &p.ExpiresAt, &p.Audience, &userIDs, &p.Categories,
		&p.Stackable, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	p.AudienceUserIDs = userIDs
	return &p, nil
}

// Create inserts a new promo. The caller validates inputs; we just enforce
// uniqueness on code (DB constraint) and basic non-negativity.
func (r *Repository) Create(ctx context.Context, req CreateRequest, createdBy string) (*Promo, error) {
	if req.Code == "" || req.DiscountValue <= 0 {
		return nil, fmt.Errorf("code and discount value required")
	}
	if req.ExpiresAt != nil && req.ExpiresAt.Before(time.Now()) {
		return nil, fmt.Errorf("expires_at must be in the future")
	}
	if req.Audience == "" {
		req.Audience = "all"
	}
	id := ""
	err := r.write.QueryRow(ctx, `
		INSERT INTO promotions (
		  code, name, description, discount_type, discount_value,
		  min_order_cents, max_uses, max_per_user, is_active, starts_at, expires_at,
		  audience, audience_user_ids, categories, stackable, created_by
		)
		VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4, $5,
		        $6, $7, $8, TRUE, $9, $10, $11, $12, $13, $14, NULLIF($15,'')::uuid)
		RETURNING id::text
	`, strings.ToUpper(req.Code), req.Name, req.Description, req.DiscountType, req.DiscountValue,
		req.MinOrderCents, req.MaxUses, req.MaxPerUser, req.StartsAt, req.ExpiresAt,
		req.Audience, req.AudienceUserIDs, req.Categories, req.Stackable, createdBy,
	).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("create promo: %w", err)
	}
	return r.Get(ctx, id)
}

// Update overwrites a promo's editable fields.
func (r *Repository) Update(ctx context.Context, id string, req CreateRequest) error {
	res, err := r.write.Exec(ctx, `
		UPDATE promotions
		SET code = $2, name = NULLIF($3, ''), description = NULLIF($4, ''),
		    discount_type = $5, discount_value = $6, min_order_cents = $7,
		    max_uses = $8, max_per_user = $9, starts_at = $10, expires_at = $11,
		    audience = $12, audience_user_ids = $13, categories = $14, stackable = $15
		WHERE id = $1::uuid
	`, id, strings.ToUpper(req.Code), req.Name, req.Description, req.DiscountType, req.DiscountValue,
		req.MinOrderCents, req.MaxUses, req.MaxPerUser, req.StartsAt, req.ExpiresAt,
		req.Audience, req.AudienceUserIDs, req.Categories, req.Stackable)
	if err != nil {
		return fmt.Errorf("update promo: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repository) SetActive(ctx context.Context, id string, active bool) error {
	res, err := r.write.Exec(ctx, `UPDATE promotions SET is_active = $2 WHERE id = $1::uuid`, id, active)
	if err != nil {
		return fmt.Errorf("set active: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Stats returns the redemption stats for one promo.
type Stats struct {
	Redemptions    int   `json:"redemptions"`
	UniqueUsers    int   `json:"unique_users"`
	DiscountCents  int64 `json:"discount_cents"`
	RevenueCents   int64 `json:"revenue_cents"`
}

func (r *Repository) Stats(ctx context.Context, code string) (*Stats, error) {
	var s Stats
	err := r.read.QueryRow(ctx, `
		SELECT COUNT(*),
		       COUNT(DISTINCT customer_id),
		       COALESCE(SUM(discount_cents), 0),
		       COALESCE(SUM(price_cents) FILTER (WHERE status = 'completed'), 0)
		FROM bookings
		WHERE promo_code = $1
	`, code).Scan(&s.Redemptions, &s.UniqueUsers, &s.DiscountCents, &s.RevenueCents)
	if err != nil {
		return nil, fmt.Errorf("promo stats: %w", err)
	}
	return &s, nil
}

// GenerateCode returns an 8-char uppercase alphanumeric not present in DB.
func (r *Repository) GenerateCode(ctx context.Context) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	for tries := 0; tries < 10; tries++ {
		buf := make([]byte, 8)
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		for i := range buf {
			buf[i] = alphabet[int(buf[i])%len(alphabet)]
		}
		code := string(buf)
		var exists bool
		if err := r.read.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM promotions WHERE code = $1)`, code,
		).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return code, nil
		}
	}
	return "", fmt.Errorf("unable to generate unique code")
}

type Handler struct {
	repo       *Repository
	recorder   *audit.Recorder
	dispatcher *webhooks.Dispatcher
}

func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// SetDispatcher wires the outbound webhook dispatcher.
func (h *Handler) SetDispatcher(d *webhooks.Dispatcher) { h.dispatcher = d }

func (h *Handler) fireWebhook(ctx context.Context, event string, payload any) {
	if h.dispatcher == nil {
		return
	}
	h.dispatcher.Dispatch(ctx, event, payload)
}

func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/promos")
	g.Get("/",                 h.List)
	g.Get("/generate-code",    h.GenerateCode)
	g.Post("/",                middleware.RequirePermission("promos.create"), h.Create)
	g.Get("/:id",              h.Get)
	g.Get("/:id/stats",        h.Stats)
	g.Put("/:id",              middleware.RequirePermission("promos.update"), h.Update)
	g.Post("/:id/deactivate",  middleware.RequirePermission("promos.toggle"), h.Deactivate)
	g.Post("/:id/activate",    middleware.RequirePermission("promos.toggle"), h.Activate)
}

func (h *Handler) List(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	items, total, err := h.repo.List(c.UserContext(), c.Query("search"), c.Query("status"), limit, offset)
	if err != nil {
		log.Error().Err(err).Msg("[crm.promos] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": items, "total_count": total, "limit": limit, "offset": offset})
}

func (h *Handler) Get(c *fiber.Ctx) error {
	out, err := h.repo.Get(c.UserContext(), c.Params("id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "promo not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
}

func (h *Handler) Stats(c *fiber.Ctx) error {
	p, err := h.repo.Get(c.UserContext(), c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "promo not found"})
	}
	out, err := h.repo.Stats(c.UserContext(), p.Code)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
}

func (h *Handler) GenerateCode(c *fiber.Ctx) error {
	code, err := h.repo.GenerateCode(c.UserContext())
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"code": code})
}

func (h *Handler) Create(c *fiber.Ctx) error {
	var req CreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	out, err := h.repo.Create(c.UserContext(), req, adminID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "promo.create", out.ID, nil, req)
	h.fireWebhook(c.UserContext(), webhooks.EventAdminPromoCreated, webhooks.AdminPromoCreatedEvent{
		PromoID:    out.ID,
		Code:       out.Code,
		AdminID:    adminID,
		OccurredAt: time.Now().UTC(),
	})
	return c.JSON(out)
}

func (h *Handler) Update(c *fiber.Ctx) error {
	var req CreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	id := c.Params("id")
	if err := h.repo.Update(c.UserContext(), id, req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "promo.update", id, nil, req)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) Deactivate(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.SetActive(c.UserContext(), id, false); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "promo.deactivate", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) Activate(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.SetActive(c.UserContext(), id, true); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "promo.activate", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "promos",
		TargetType: "promo", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}
