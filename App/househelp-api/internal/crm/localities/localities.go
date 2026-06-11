// Package localities exposes CRUD over the localities table — the operational
// areas every helper picks one of and every booking snapshots at create
// time. CRM-only management surface; the user-app reads the active subset
// via a public endpoint mounted in cmd/api.
package localities

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"

	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

// ErrNotFound is returned by Get / Update / Delete when the row is missing.
var ErrNotFound = errors.New("locality not found")

// ErrConflict is returned when an INSERT or UPDATE would collide on the
// unique (name, city) constraint.
var ErrConflict = errors.New("locality already exists for that city")

// Locality is the wire shape for the table.
type Locality struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	City      string    `json:"city"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"created_at"`
}

// Repository is the table-level layer.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository wires a Repository.
func NewRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

// List returns every locality, optionally filtered by city / active.
// Sorted by city, then name. The CRM table page consumes this directly.
func (r *Repository) List(ctx context.Context, city string, activeOnly bool) ([]Locality, error) {
	args := []any{}
	conds := []string{"true"}
	if city != "" {
		args = append(args, city)
		conds = append(conds, fmt.Sprintf("city = $%d", len(args)))
	}
	if activeOnly {
		conds = append(conds, "active = true")
	}
	q := "SELECT id::text, name, city, active, created_at FROM localities WHERE " +
		strings.Join(conds, " AND ") +
		" ORDER BY city, name"

	rows, err := r.db.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list localities: %w", err)
	}
	defer rows.Close()

	out := []Locality{}
	for rows.Next() {
		var l Locality
		if err := rows.Scan(&l.ID, &l.Name, &l.City, &l.Active, &l.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan locality: %w", err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// Create inserts a new locality. Returns ErrConflict on (name, city) clash.
func (r *Repository) Create(ctx context.Context, name, city string) (*Locality, error) {
	var l Locality
	err := r.db.QueryRow(ctx, `
		INSERT INTO localities (name, city, active)
		VALUES ($1, $2, true)
		RETURNING id::text, name, city, active, created_at
	`, name, city).Scan(&l.ID, &l.Name, &l.City, &l.Active, &l.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, fmt.Errorf("insert locality: %w", err)
	}
	return &l, nil
}

// Update changes name / city / active for an existing row. helpers.locality
// and bookings.locality are plain-text name snapshots (no FK), so a rename
// must cascade to them in the same tx or every pro in that area silently stops
// matching new bookings (matched by name via ILIKE in the dispatcher).
func (r *Repository) Update(ctx context.Context, id, name, city string, active bool) (*Locality, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin update locality: %w", err)
	}
	defer tx.Rollback(ctx)

	var oldName string
	if err := tx.QueryRow(ctx, `SELECT name FROM localities WHERE id = $1::uuid FOR UPDATE`, id).Scan(&oldName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("load locality: %w", err)
	}

	var l Locality
	err = tx.QueryRow(ctx, `
		UPDATE localities
		SET name = $2, city = $3, active = $4
		WHERE id = $1::uuid
		RETURNING id::text, name, city, active, created_at
	`, id, name, city, active).Scan(&l.ID, &l.Name, &l.City, &l.Active, &l.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, fmt.Errorf("update locality: %w", err)
	}

	if oldName != name {
		if _, err := tx.Exec(ctx, `UPDATE helpers SET locality = $1 WHERE locality = $2`, name, oldName); err != nil {
			return nil, fmt.Errorf("cascade locality rename to helpers: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE bookings SET locality = $1 WHERE locality = $2`, name, oldName); err != nil {
			return nil, fmt.Errorf("cascade locality rename to bookings: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit update locality: %w", err)
	}
	return &l, nil
}

// Delete removes a locality. Helpers / bookings holding a snapshot of
// localities.name keep functioning — the FK is by name, not id.
func (r *Repository) Delete(ctx context.Context, id string) error {
	ct, err := r.db.Exec(ctx, `DELETE FROM localities WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("delete locality: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// isUniqueViolation matches the Postgres SQLSTATE for unique_violation
// without dragging in pgconn's typed errors at every site.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23505")
}

// ── Handler ──────────────────────────────────────────────────────────────────

// Handler is the HTTP layer.
type Handler struct {
	repo     *Repository
	recorder *audit.Recorder
}

// NewHandler wires a Handler. recorder may be nil — audit logging becomes a
// no-op (handy in tests / public-only builds).
func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// audit mirrors the helper used by other CRM modules so the action log
// table stays consistent.
func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "localities",
		TargetType: "locality", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}

// RegisterRoutes mounts /localities under the (already-authed) admin group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Get("/localities", middleware.RequirePermission("localities.read"), h.List)
	router.Post("/localities", middleware.RequirePermission("localities.create"), h.Create)
	router.Patch("/localities/:id", middleware.RequirePermission("localities.update"), h.Update)
	router.Delete("/localities/:id", middleware.RequirePermission("localities.delete"), h.Delete)
}

// RegisterPublicRoutes mounts the read-only subset for the pro app: only
// active rows are returned, no auth required (pro app calls before login
// during onboarding too).
func (h *Handler) RegisterPublicRoutes(router fiber.Router) {
	router.Get("/", h.PublicList)
}

// PublicList — GET /localities (active only, optional ?city=).
func (h *Handler) PublicList(c *fiber.Ctx) error {
	city := strings.TrimSpace(c.Query("city"))
	out, err := h.repo.List(c.UserContext(), city, true)
	if err != nil {
		log.Error().Err(err).Msg("[localities.public] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load localities"})
	}
	return c.JSON(fiber.Map{"localities": out})
}

// List — GET /admin/localities. Optional ?city=, ?active=true|false.
func (h *Handler) List(c *fiber.Ctx) error {
	city := strings.TrimSpace(c.Query("city"))
	activeOnly := c.Query("active") == "true"
	out, err := h.repo.List(c.UserContext(), city, activeOnly)
	if err != nil {
		log.Error().Err(err).Msg("[localities] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load localities"})
	}
	return c.JSON(fiber.Map{"localities": out})
}

type createReq struct {
	Name string `json:"name"`
	City string `json:"city"`
}

type updateReq struct {
	Name   string `json:"name"`
	City   string `json:"city"`
	Active bool   `json:"active"`
}

// Create — POST /admin/localities.
func (h *Handler) Create(c *fiber.Ctx) error {
	var req createReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	req.Name = strings.TrimSpace(req.Name)
	req.City = strings.TrimSpace(req.City)
	if req.Name == "" || req.City == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name and city are required"})
	}
	l, err := h.repo.Create(c.UserContext(), req.Name, req.City)
	switch {
	case err == nil:
		h.audit(c, "locality.create", l.ID, nil, l)
		return c.Status(fiber.StatusCreated).JSON(l)
	case errors.Is(err, ErrConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "already exists for that city"})
	default:
		log.Error().Err(err).Msg("[localities] create failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create"})
	}
}

// Update — PATCH /admin/localities/:id.
func (h *Handler) Update(c *fiber.Ctx) error {
	id := c.Params("id")
	var req updateReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	req.Name = strings.TrimSpace(req.Name)
	req.City = strings.TrimSpace(req.City)
	if req.Name == "" || req.City == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name and city are required"})
	}
	l, err := h.repo.Update(c.UserContext(), id, req.Name, req.City, req.Active)
	switch {
	case err == nil:
		h.audit(c, "locality.update", id, nil, l)
		return c.JSON(l)
	case errors.Is(err, ErrNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "not found"})
	case errors.Is(err, ErrConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "already exists for that city"})
	default:
		log.Error().Err(err).Msg("[localities] update failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update"})
	}
}

// Delete — DELETE /admin/localities/:id.
func (h *Handler) Delete(c *fiber.Ctx) error {
	id := c.Params("id")
	switch err := h.repo.Delete(c.UserContext(), id); {
	case err == nil:
		h.audit(c, "locality.delete", id, nil, nil)
		return c.JSON(fiber.Map{"ok": true})
	case errors.Is(err, ErrNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "not found"})
	default:
		log.Error().Err(err).Msg("[localities] delete failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete"})
	}
}
