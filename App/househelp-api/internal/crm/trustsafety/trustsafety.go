// Package trustsafety bundles disputes, fraud flags, blacklist, and
// incidents into one HTTP surface. Each is a thin CRUD shell over its
// crm_* table — combined so the routing surface stays compact.
package trustsafety

import (
	"context"
	"encoding/json"
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

// ErrNotFound means the targeted row was missing or not in a state the
// mutation could act on. Returned instead of wrapping a nil error with %w,
// which previously rendered a garbled "%!w(<nil>)" string to admins.
var ErrNotFound = errors.New("not found")

type Dispute struct {
	ID          string     `json:"id"`
	BookingID   *string    `json:"booking_id,omitempty"`
	CustomerID  *string    `json:"customer_id,omitempty"`
	WorkerID    *string    `json:"worker_id,omitempty"`
	Source      string     `json:"source"`
	Description string     `json:"description"`
	Severity    string     `json:"severity"`
	Level       string     `json:"level"`
	Status      string     `json:"status"`
	Resolution  *string    `json:"resolution,omitempty"`
	AssignedTo  *string    `json:"assigned_to,omitempty"`
	SLADueAt    *time.Time `json:"sla_due_at,omitempty"`
	ResolvedAt  *time.Time `json:"resolved_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

type DisputeRequest struct {
	BookingID   string `json:"booking_id"`
	CustomerID  string `json:"customer_id"`
	WorkerID    string `json:"worker_id"`
	Source      string `json:"source"`
	Description string `json:"description"`
	Severity    string `json:"severity"`
}

type FraudFlag struct {
	ID        string          `json:"id"`
	UserID    *string         `json:"user_id,omitempty"`
	Pattern   string          `json:"pattern"`
	Details   json.RawMessage `json:"details,omitempty"`
	Status    string          `json:"status"`
	CreatedAt time.Time       `json:"created_at"`
}

type BlacklistEntry struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Value     string    `json:"value"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"created_at"`
}

type Incident struct {
	ID               string     `json:"id"`
	Severity         string     `json:"severity"`
	Source           string     `json:"source"`
	Description      string     `json:"description"`
	InvolvedUserID   *string    `json:"involved_user_id,omitempty"`
	InvolvedWorkerID *string    `json:"involved_worker_id,omitempty"`
	ActionsTaken     *string    `json:"actions_taken,omitempty"`
	Status           string     `json:"status"`
	ResolvedAt       *time.Time `json:"resolved_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
}

type Service struct{ read, write *pgxpool.Pool }

func NewService(read, write *pgxpool.Pool) *Service { return &Service{read: read, write: write} }

// ── Disputes ───────────────────────────────────────────────────────────

func (s *Service) ListDisputes(ctx context.Context, status string, limit int) ([]Dispute, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	args := []any{}
	cond := ""
	if status != "" {
		args = append(args, status)
		cond = "WHERE status = $1"
	}
	args = append(args, limit)
	rows, err := s.read.Query(ctx, fmt.Sprintf(`
		SELECT id::text, booking_id::text, customer_id::text, worker_id::text,
		       source, description, severity, level, status, resolution,
		       assigned_to::text, sla_due_at, resolved_at, created_at
		FROM crm_disputes %s ORDER BY created_at DESC LIMIT $%d
	`, cond, len(args)), args...)
	if err != nil {
		return nil, fmt.Errorf("list disputes: %w", err)
	}
	defer rows.Close()
	out := []Dispute{}
	for rows.Next() {
		var d Dispute
		if err := rows.Scan(&d.ID, &d.BookingID, &d.CustomerID, &d.WorkerID,
			&d.Source, &d.Description, &d.Severity, &d.Level, &d.Status, &d.Resolution,
			&d.AssignedTo, &d.SLADueAt, &d.ResolvedAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Service) CreateDispute(ctx context.Context, req DisputeRequest) (string, error) {
	if req.Description == "" {
		return "", errors.New("description required")
	}
	if req.Severity == "" {
		req.Severity = "medium"
	}
	if req.Source == "" {
		req.Source = "admin"
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_disputes (booking_id, customer_id, worker_id, source, description, severity, sla_due_at)
		VALUES (NULLIF($1, '')::uuid, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, $4, $5, $6, now() + interval '48 hours')
		RETURNING id::text
	`, req.BookingID, req.CustomerID, req.WorkerID, req.Source, req.Description, req.Severity).Scan(&id)
	return id, err
}

func (s *Service) ResolveDispute(ctx context.Context, id, resolution string) error {
	res, err := s.write.Exec(ctx, `
		UPDATE crm_disputes SET status='resolved', resolution=$2, resolved_at=now(), updated_at=now()
		WHERE id = $1::uuid AND status NOT IN ('resolved','closed')
	`, id, resolution)
	if err != nil {
		return fmt.Errorf("resolve dispute: %w", err)
	}
	if res.RowsAffected() == 0 {
		// Either the id does not exist or the dispute is already
		// resolved/closed — both must not silently overwrite the outcome.
		return ErrNotFound
	}
	return nil
}

// SetDisputeStatus moves an open/in-progress dispute along the triage
// workflow ('in_progress', 'escalated'). 'resolved' goes through
// ResolveDispute (which records the outcome); this path is for the
// intermediate states the SLA-escalation workflow needs.
func (s *Service) SetDisputeStatus(ctx context.Context, id, status string) error {
	if status != "in_progress" && status != "escalated" {
		return errors.New("status must be in_progress or escalated")
	}
	res, err := s.write.Exec(ctx, `
		UPDATE crm_disputes SET status=$2, updated_at=now()
		WHERE id = $1::uuid AND status NOT IN ('resolved','closed')
	`, id, status)
	if err != nil {
		return fmt.Errorf("set dispute status: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ── Fraud flags ────────────────────────────────────────────────────────

func (s *Service) ListFraud(ctx context.Context, status string) ([]FraudFlag, error) {
	args := []any{}
	cond := ""
	if status != "" {
		args = append(args, status)
		cond = "WHERE status = $1"
	}
	rows, err := s.read.Query(ctx, fmt.Sprintf(`
		SELECT id::text, user_id::text, pattern, details, status, created_at
		FROM crm_fraud_flags %s ORDER BY created_at DESC LIMIT 200
	`, cond), args...)
	if err != nil {
		return nil, fmt.Errorf("list fraud: %w", err)
	}
	defer rows.Close()
	out := []FraudFlag{}
	for rows.Next() {
		var f FraudFlag
		if err := rows.Scan(&f.ID, &f.UserID, &f.Pattern, &f.Details, &f.Status, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Service) ReviewFraud(ctx context.Context, id, status string) error {
	if status != "reviewed_false" && status != "actioned" {
		return errors.New("status must be reviewed_false or actioned")
	}
	res, err := s.write.Exec(ctx,
		`UPDATE crm_fraud_flags SET status=$2, reviewed_at=now() WHERE id=$1::uuid`, id, status)
	if err != nil {
		return fmt.Errorf("review fraud: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ── Blacklist ──────────────────────────────────────────────────────────

func (s *Service) ListBlacklist(ctx context.Context) ([]BlacklistEntry, error) {
	rows, err := s.read.Query(ctx, `
		SELECT id::text, kind, value, reason, created_at
		FROM crm_blacklist ORDER BY created_at DESC LIMIT 500
	`)
	if err != nil {
		return nil, fmt.Errorf("list blacklist: %w", err)
	}
	defer rows.Close()
	out := []BlacklistEntry{}
	for rows.Next() {
		var b BlacklistEntry
		if err := rows.Scan(&b.ID, &b.Kind, &b.Value, &b.Reason, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Service) AddBlacklist(ctx context.Context, kind, value, reason, createdBy string) (string, error) {
	if kind == "" || value == "" || reason == "" {
		return "", errors.New("kind, value, reason required")
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_blacklist (kind, value, reason, created_by)
		VALUES ($1, $2, $3, NULLIF($4, '')::uuid)
		ON CONFLICT (kind, value) DO UPDATE SET reason = EXCLUDED.reason
		RETURNING id::text
	`, kind, value, reason, createdBy).Scan(&id)
	return id, err
}

func (s *Service) RemoveBlacklist(ctx context.Context, id string) error {
	res, err := s.write.Exec(ctx, `DELETE FROM crm_blacklist WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("remove blacklist: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ── Incidents ──────────────────────────────────────────────────────────

func (s *Service) ListIncidents(ctx context.Context) ([]Incident, error) {
	rows, err := s.read.Query(ctx, `
		SELECT id::text, severity, source, description, involved_user_id::text, involved_worker_id::text,
		       actions_taken, status, resolved_at, created_at
		FROM crm_incidents ORDER BY created_at DESC LIMIT 200
	`)
	if err != nil {
		return nil, fmt.Errorf("list incidents: %w", err)
	}
	defer rows.Close()
	out := []Incident{}
	for rows.Next() {
		var i Incident
		if err := rows.Scan(&i.ID, &i.Severity, &i.Source, &i.Description,
			&i.InvolvedUserID, &i.InvolvedWorkerID, &i.ActionsTaken,
			&i.Status, &i.ResolvedAt, &i.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

type IncidentRequest struct {
	Severity         string `json:"severity"`
	Source           string `json:"source"`
	Description      string `json:"description"`
	InvolvedUserID   string `json:"involved_user_id"`
	InvolvedWorkerID string `json:"involved_worker_id"`
	ActionsTaken     string `json:"actions_taken"`
}

func (s *Service) CreateIncident(ctx context.Context, req IncidentRequest, createdBy string) (string, error) {
	if req.Description == "" || req.Severity == "" || req.Source == "" {
		return "", errors.New("severity, source, description required")
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_incidents (severity, source, description, involved_user_id, involved_worker_id, actions_taken, created_by)
		VALUES ($1, $2, $3, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid, NULLIF($6, ''), NULLIF($7, '')::uuid)
		RETURNING id::text
	`, req.Severity, req.Source, req.Description, req.InvolvedUserID, req.InvolvedWorkerID, req.ActionsTaken, createdBy).Scan(&id)
	return id, err
}

func (s *Service) ResolveIncident(ctx context.Context, id string) error {
	res, err := s.write.Exec(ctx, `UPDATE crm_incidents SET status='resolved', resolved_at=now() WHERE id=$1::uuid`, id)
	if err != nil {
		return fmt.Errorf("resolve incident: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ── Handler ────────────────────────────────────────────────────────────

type Handler struct {
	svc      *Service
	recorder *audit.Recorder
}

func NewHandler(svc *Service, recorder *audit.Recorder) *Handler {
	return &Handler{svc: svc, recorder: recorder}
}

func (h *Handler) RegisterRoutes(r fiber.Router) {
	d := r.Group("/disputes")
	d.Get("/", middleware.RequirePermission("disputes.read"), h.ListDisputes)
	d.Post("/", middleware.RequirePermission("disputes.create"), h.CreateDispute)
	d.Post("/:id/resolve", middleware.RequirePermission("disputes.resolve"), h.ResolveDispute)
	d.Post("/:id/status", middleware.RequirePermission("disputes.resolve"), h.SetDisputeStatus)

	f := r.Group("/fraud")
	f.Get("/", middleware.RequirePermission("fraud.read"), h.ListFraud)
	f.Post("/:id/review", middleware.RequirePermission("fraud.review"), h.ReviewFraud)

	b := r.Group("/blacklist")
	b.Get("/", middleware.RequirePermission("blacklist.read"), h.ListBlacklist)
	b.Post("/", middleware.RequirePermission("blacklist.add"), h.AddBlacklist)
	b.Delete("/:id", middleware.RequirePermission("blacklist.remove"), h.RemoveBlacklist)

	in := r.Group("/incidents")
	in.Get("/", middleware.RequirePermission("incidents.read"), h.ListIncidents)
	in.Post("/", middleware.RequirePermission("incidents.create"), h.CreateIncident)
	in.Post("/:id/resolve", middleware.RequirePermission("incidents.resolve"), h.ResolveIncident)
}

func (h *Handler) ListDisputes(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	out, err := h.svc.ListDisputes(c.UserContext(), c.Query("status"), limit)
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateDispute(c *fiber.Ctx) error {
	var req DisputeRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	id, err := h.svc.CreateDispute(c.UserContext(), req)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "dispute.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) ResolveDispute(c *fiber.Ctx) error {
	var body struct {
		Resolution string `json:"resolution"`
	}
	_ = c.BodyParser(&body)
	id := c.Params("id")
	if err := h.svc.ResolveDispute(c.UserContext(), id, body.Resolution); err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "dispute not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	h.audit(c, "dispute.resolve", id, nil, body.Resolution)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) SetDisputeStatus(c *fiber.Ctx) error {
	var body struct {
		Status string `json:"status"`
	}
	_ = c.BodyParser(&body)
	id := c.Params("id")
	if err := h.svc.SetDisputeStatus(c.UserContext(), id, body.Status); err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "dispute not found or already resolved"})
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "dispute.status", id, nil, body.Status)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListFraud(c *fiber.Ctx) error {
	out, err := h.svc.ListFraud(c.UserContext(), c.Query("status"))
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) ReviewFraud(c *fiber.Ctx) error {
	var body struct {
		Status string `json:"status"`
	}
	_ = c.BodyParser(&body)
	id := c.Params("id")
	if err := h.svc.ReviewFraud(c.UserContext(), id, body.Status); err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "fraud flag not found"})
		}
		// validation error (bad status) vs DB error
		if err.Error() == "status must be reviewed_false or actioned" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	h.audit(c, "fraud.review", id, nil, body.Status)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListBlacklist(c *fiber.Ctx) error {
	out, err := h.svc.ListBlacklist(c.UserContext())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) AddBlacklist(c *fiber.Ctx) error {
	var body struct {
		Kind, Value, Reason string
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	id, err := h.svc.AddBlacklist(c.UserContext(), body.Kind, body.Value, body.Reason, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "blacklist.add", id, nil, body)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) RemoveBlacklist(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.svc.RemoveBlacklist(c.UserContext(), id); err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "blacklist entry not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	h.audit(c, "blacklist.remove", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListIncidents(c *fiber.Ctx) error {
	out, err := h.svc.ListIncidents(c.UserContext())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateIncident(c *fiber.Ctx) error {
	var req IncidentRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	id, err := h.svc.CreateIncident(c.UserContext(), req, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "incident.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) ResolveIncident(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.svc.ResolveIncident(c.UserContext(), id); err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "incident not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	h.audit(c, "incident.resolve", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "trustsafety",
		TargetType: "ts", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}

func jsonOrErr(c *fiber.Ctx, payload any, err error) error {
	if err != nil {
		log.Error().Err(err).Msg("[crm.ts] query failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(payload)
}
