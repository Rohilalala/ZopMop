// Package experiments manages crm_experiments rows. The CRM stores variant
// definitions and lifecycle state; bucket assignment + metric collection
// live in the user-app and report back via /admin/experiments/:id/results
// (stub for now — wired to crm_audit_log placeholder data).
package experiments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

var ErrNotFound = errors.New("experiment not found")

type Variant struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Value      any    `json:"value"`
	TrafficPct int    `json:"traffic_pct"`
}

type Experiment struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Hypothesis    *string    `json:"hypothesis,omitempty"`
	Kind          string     `json:"kind"`
	TargetKey     *string    `json:"target_key,omitempty"`
	Variants      []Variant  `json:"variants"`
	Metric        string     `json:"metric"`
	Audience      string     `json:"audience"`
	Status        string     `json:"status"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	EndedAt       *time.Time `json:"ended_at,omitempty"`
	WinnerVariant *string    `json:"winner_variant,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type CreateRequest struct {
	Name       string    `json:"name"`
	Hypothesis string    `json:"hypothesis"`
	Kind       string    `json:"kind"`
	TargetKey  string    `json:"target_key"`
	Variants   []Variant `json:"variants"`
	Metric     string    `json:"metric"`
	Audience   string    `json:"audience"`
}

type Repository struct{ read, write *pgxpool.Pool }

func NewRepository(read, write *pgxpool.Pool) *Repository { return &Repository{read: read, write: write} }

func validate(req CreateRequest) error {
	if strings.TrimSpace(req.Name) == "" {
		return fmt.Errorf("name required")
	}
	if req.Kind == "" {
		return fmt.Errorf("kind required")
	}
	if len(req.Variants) < 2 {
		return fmt.Errorf("at least two variants required (control + 1)")
	}
	sum := 0
	for _, v := range req.Variants {
		if v.TrafficPct < 0 {
			return fmt.Errorf("traffic_pct must be >= 0")
		}
		sum += v.TrafficPct
	}
	if sum != 100 {
		return fmt.Errorf("variant traffic_pct must sum to 100, got %d", sum)
	}
	return nil
}

func scanExperiment(row pgx.Row) (*Experiment, error) {
	var (
		e      Experiment
		varRaw []byte
	)
	err := row.Scan(&e.ID, &e.Name, &e.Hypothesis, &e.Kind, &e.TargetKey,
		&varRaw, &e.Metric, &e.Audience, &e.Status, &e.StartedAt, &e.EndedAt,
		&e.WinnerVariant, &e.CreatedAt, &e.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(varRaw, &e.Variants); err != nil {
		return nil, fmt.Errorf("decode variants: %w", err)
	}
	return &e, nil
}

func (r *Repository) List(ctx context.Context) ([]Experiment, error) {
	rows, err := r.read.Query(ctx, `
		SELECT id::text, name, hypothesis, kind, target_key, variants, metric,
		       audience, status, started_at, ended_at, winner_variant,
		       created_at, updated_at
		FROM crm_experiments
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list experiments: %w", err)
	}
	defer rows.Close()
	out := []Experiment{}
	for rows.Next() {
		e, err := scanExperiment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

func (r *Repository) Get(ctx context.Context, id string) (*Experiment, error) {
	return scanExperiment(r.read.QueryRow(ctx, `
		SELECT id::text, name, hypothesis, kind, target_key, variants, metric,
		       audience, status, started_at, ended_at, winner_variant,
		       created_at, updated_at
		FROM crm_experiments WHERE id = $1::uuid
	`, id))
}

func (r *Repository) Create(ctx context.Context, req CreateRequest, createdBy string) (*Experiment, error) {
	if err := validate(req); err != nil {
		return nil, err
	}
	if req.Audience == "" {
		req.Audience = "all"
	}
	varsJSON, _ := json.Marshal(req.Variants)
	id := ""
	err := r.write.QueryRow(ctx, `
		INSERT INTO crm_experiments (name, hypothesis, kind, target_key, variants, metric, audience, created_by)
		VALUES ($1, NULLIF($2, ''), $3, NULLIF($4, ''), $5::jsonb, $6, $7, NULLIF($8, '')::uuid)
		RETURNING id::text
	`, req.Name, req.Hypothesis, req.Kind, req.TargetKey, varsJSON, req.Metric, req.Audience, createdBy).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("create experiment: %w", err)
	}
	return r.Get(ctx, id)
}

func (r *Repository) SetStatus(ctx context.Context, id, status, winner string) error {
	args := []any{id, status}
	sql := `UPDATE crm_experiments SET status = $2, updated_at = now()`
	switch status {
	case "running":
		sql += `, started_at = COALESCE(started_at, now())`
	case "completed", "rolled_out":
		sql += `, ended_at = COALESCE(ended_at, now())`
		if winner != "" {
			args = append(args, winner)
			sql += fmt.Sprintf(", winner_variant = $%d", len(args))
		}
	}
	sql += ` WHERE id = $1::uuid`
	res, err := r.write.Exec(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("set status: %w", err)
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
	g := r.Group("/experiments")
	g.Get("/",        h.List)
	g.Post("/",       h.Create)
	g.Get("/:id",     h.Get)
	g.Post("/:id/start",  h.Start)
	g.Post("/:id/pause",  h.Pause)
	g.Post("/:id/stop",   h.Stop)
	g.Post("/:id/rollout", h.Rollout)
}

func (h *Handler) List(c *fiber.Ctx) error {
	out, err := h.repo.List(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("[crm.experiments] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": out})
}

func (h *Handler) Get(c *fiber.Ctx) error {
	out, err := h.repo.Get(c.Context(), c.Params("id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "experiment not found"})
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
	out, err := h.repo.Create(c.Context(), req, adminID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "experiment.create", out.ID, nil, req)
	return c.JSON(out)
}

func (h *Handler) Start(c *fiber.Ctx) error   { return h.statusChange(c, "running",   "experiment.start") }
func (h *Handler) Pause(c *fiber.Ctx) error   { return h.statusChange(c, "paused",    "experiment.pause") }
func (h *Handler) Stop(c *fiber.Ctx) error    { return h.statusChange(c, "completed", "experiment.stop") }

func (h *Handler) Rollout(c *fiber.Ctx) error {
	var body struct {
		Winner string `json:"winner"`
	}
	if err := c.BodyParser(&body); err != nil || body.Winner == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "winner variant id required"})
	}
	id := c.Params("id")
	if err := h.repo.SetStatus(c.Context(), id, "rolled_out", body.Winner); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "experiment.rollout", id, nil, body.Winner)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) statusChange(c *fiber.Ctx, status, action string) error {
	id := c.Params("id")
	if err := h.repo.SetStatus(c.Context(), id, status, ""); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, action, id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.Context(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "experiments",
		TargetType: "experiment", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}
