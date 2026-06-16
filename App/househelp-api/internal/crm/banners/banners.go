// Package banners manages the home-screen banners table from the CRM.
// The image_url field is a URL to an externally-hosted image; this CRM
// does not handle uploads itself — admins paste a CDN URL after uploading
// elsewhere. (Adding S3 presign here is a future TODO.)
package banners

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

var ErrNotFound = errors.New("banner not found")

// ErrReorderMismatch is returned when a reorder list does not cover exactly
// the current set of banners (missing, extra, or duplicate ids). Applying a
// partial list would leave un-listed banners at their old display_order,
// producing duplicate orders.
var ErrReorderMismatch = errors.New("reorder list must contain exactly the current banner ids, once each")

// bannersReorderLockKey is an arbitrary constant key for pg_advisory_xact_lock
// so concurrent reorders serialize instead of interleaving into a corrupt
// (duplicated / non-sequential) display_order.
const bannersReorderLockKey int64 = 0x7A4D_4252 // 'zMBR'

type Banner struct {
	ID           string     `json:"id"`
	Title        string     `json:"title"`
	Subtitle     *string    `json:"subtitle,omitempty"`
	ImageURL     string     `json:"image_url"`
	TapAction    *string    `json:"tap_action,omitempty"`
	CTALabel     *string    `json:"cta_label,omitempty"`
	CTAKind      *string    `json:"cta_kind,omitempty"`
	DisplayOrder int        `json:"display_order"`
	IsActive     bool       `json:"is_active"`
	StartsAt     *time.Time `json:"starts_at,omitempty"`
	EndsAt       *time.Time `json:"ends_at,omitempty"`
	Audience     string     `json:"audience"`
	AudienceZone *string    `json:"audience_zone,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

type CreateRequest struct {
	Title        string     `json:"title"`
	Subtitle     string     `json:"subtitle"`
	ImageURL     string     `json:"image_url"`
	TapAction    string     `json:"tap_action"`
	CTALabel     string     `json:"cta_label"`
	CTAKind      string     `json:"cta_kind"`
	DisplayOrder int        `json:"display_order"`
	IsActive     bool       `json:"is_active"`
	StartsAt     *time.Time `json:"starts_at"`
	EndsAt       *time.Time `json:"ends_at"`
	Audience     string     `json:"audience"`
	AudienceZone string     `json:"audience_zone"`
}

type Repository struct{ read, write *pgxpool.Pool }

func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

func (r *Repository) List(ctx context.Context) ([]Banner, error) {
	rows, err := r.read.Query(ctx, `
		SELECT id::text, title, subtitle, image_url, tap_action, cta_label, cta_kind,
		       display_order, is_active, starts_at, ends_at,
		       audience, audience_zone::text, created_at
		FROM banners
		ORDER BY display_order ASC, created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list banners: %w", err)
	}
	defer rows.Close()
	out := []Banner{}
	for rows.Next() {
		var b Banner
		if err := rows.Scan(&b.ID, &b.Title, &b.Subtitle, &b.ImageURL, &b.TapAction, &b.CTALabel, &b.CTAKind,
			&b.DisplayOrder, &b.IsActive, &b.StartsAt, &b.EndsAt,
			&b.Audience, &b.AudienceZone, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (r *Repository) Get(ctx context.Context, id string) (*Banner, error) {
	var b Banner
	err := r.read.QueryRow(ctx, `
		SELECT id::text, title, subtitle, image_url, tap_action, cta_label, cta_kind,
		       display_order, is_active, starts_at, ends_at,
		       audience, audience_zone::text, created_at
		FROM banners WHERE id = $1::uuid
	`, id).Scan(&b.ID, &b.Title, &b.Subtitle, &b.ImageURL, &b.TapAction, &b.CTALabel, &b.CTAKind,
		&b.DisplayOrder, &b.IsActive, &b.StartsAt, &b.EndsAt,
		&b.Audience, &b.AudienceZone, &b.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// validate checks required fields and applies the audience default. Takes a
// pointer so the "" → "all" default actually reaches the caller's struct
// before it is bound into the INSERT/UPDATE — otherwise an omitted audience
// inserts ” and trips the banners.audience CHECK constraint.
func validate(req *CreateRequest) error {
	if strings.TrimSpace(req.Title) == "" {
		return fmt.Errorf("title required")
	}
	if strings.TrimSpace(req.ImageURL) == "" {
		return fmt.Errorf("image_url required")
	}
	if len(req.Title) > 200 {
		return fmt.Errorf("title too long")
	}
	if req.Audience == "" {
		req.Audience = "all"
	}
	return nil
}

func (r *Repository) Create(ctx context.Context, req CreateRequest, createdBy string) (*Banner, error) {
	if err := validate(&req); err != nil {
		return nil, err
	}
	id := ""
	err := r.write.QueryRow(ctx, `
		INSERT INTO banners (
		  title, subtitle, image_url, tap_action, cta_label, cta_kind,
		  display_order, is_active, starts_at, ends_at, audience, audience_zone, created_by
		)
		VALUES ($1, NULLIF($2, ''), $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
		        $7, $8, $9, $10, $11, NULLIF($12, '')::uuid, NULLIF($13, '')::uuid)
		RETURNING id::text
	`, req.Title, req.Subtitle, req.ImageURL, req.TapAction, req.CTALabel, req.CTAKind,
		req.DisplayOrder, req.IsActive, req.StartsAt, req.EndsAt, req.Audience, req.AudienceZone, createdBy,
	).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("create banner: %w", err)
	}
	return r.Get(ctx, id)
}

func (r *Repository) Update(ctx context.Context, id string, req CreateRequest) error {
	if err := validate(&req); err != nil {
		return err
	}
	res, err := r.write.Exec(ctx, `
		UPDATE banners
		SET title = $2, subtitle = NULLIF($3, ''), image_url = $4,
		    tap_action = NULLIF($5, ''), cta_label = NULLIF($6, ''), cta_kind = NULLIF($7, ''),
		    display_order = $8, is_active = $9, starts_at = $10, ends_at = $11,
		    audience = $12, audience_zone = NULLIF($13, '')::uuid, updated_at = now()
		WHERE id = $1::uuid
	`, id, req.Title, req.Subtitle, req.ImageURL, req.TapAction, req.CTALabel, req.CTAKind,
		req.DisplayOrder, req.IsActive, req.StartsAt, req.EndsAt, req.Audience, req.AudienceZone)
	if err != nil {
		return fmt.Errorf("update banner: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repository) Delete(ctx context.Context, id string) error {
	res, err := r.write.Exec(ctx, `DELETE FROM banners WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("delete banner: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Reorder sets display_order=index for the given ids. The list must cover
// exactly the current banner set; the write is serialized by an advisory lock
// so concurrent/stale reorders cannot interleave into duplicate orders.
func (r *Repository) Reorder(ctx context.Context, ids []string) error {
	tx, err := r.write.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin reorder: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize concurrent reorders for the whole transaction.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, bannersReorderLockKey); err != nil {
		return fmt.Errorf("lock banners: %w", err)
	}

	// Load the current set and require the submitted ids to match it exactly
	// (same membership, no missing/extra/duplicate). A partial or stale list
	// is rejected rather than corrupting display_order.
	rows, err := tx.Query(ctx, `SELECT id::text FROM banners`)
	if err != nil {
		return fmt.Errorf("load banners: %w", err)
	}
	existing := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		existing[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	if len(ids) != len(existing) {
		return ErrReorderMismatch
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !existing[id] || seen[id] {
			return ErrReorderMismatch
		}
		seen[id] = true
	}

	for i, id := range ids {
		if _, err := tx.Exec(ctx,
			`UPDATE banners SET display_order = $2, updated_at = now() WHERE id = $1::uuid`, id, i,
		); err != nil {
			return fmt.Errorf("update order: %w", err)
		}
	}
	return tx.Commit(ctx)
}

type Handler struct {
	repo     *Repository
	recorder *audit.Recorder
}

func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/banners")
	read := middleware.RequirePermission("banners.read")
	g.Get("/", read, h.List)
	g.Post("/", middleware.RequirePermission("banners.create"), h.Create)
	g.Post("/reorder", middleware.RequirePermission("banners.reorder"), h.Reorder)
	g.Get("/:id", read, h.Get)
	g.Put("/:id", middleware.RequirePermission("banners.update"), h.Update)
	g.Delete("/:id", middleware.RequirePermission("banners.delete"), h.Delete)
}

func (h *Handler) List(c *fiber.Ctx) error {
	out, err := h.repo.List(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.banners] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": out})
}

func (h *Handler) Get(c *fiber.Ctx) error {
	out, err := h.repo.Get(c.UserContext(), c.Params("id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "banner not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
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
	h.audit(c, "banner.create", out.ID, nil, req)
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
	h.audit(c, "banner.update", id, nil, req)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) Delete(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.Delete(c.UserContext(), id); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "banner.delete", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) Reorder(c *fiber.Ctx) error {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if err := h.repo.Reorder(c.UserContext(), body.IDs); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "banner.reorder", "", nil, body.IDs)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "banners",
		TargetType: "banner", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}
