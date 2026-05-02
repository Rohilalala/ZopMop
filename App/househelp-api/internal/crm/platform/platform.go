// Package platform bundles low-traffic platform tools: webhooks, response
// templates, support tickets, app version policy, changelog, and an
// append-only audit log viewer. Combined for compactness.
package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

// ── Models ─────────────────────────────────────────────────────────────

type Webhook struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	Events    []string  `json:"events"`
	IsActive  bool      `json:"is_active"`
	CreatedAt time.Time `json:"created_at"`
}

type WebhookDelivery struct {
	ID         int64           `json:"id"`
	WebhookID  string          `json:"webhook_id"`
	Event      string          `json:"event"`
	Payload    json.RawMessage `json:"payload"`
	StatusCode *int            `json:"status_code,omitempty"`
	Succeeded  bool            `json:"succeeded"`
	CreatedAt  time.Time       `json:"created_at"`
}

type Template struct {
	ID        string    `json:"id"`
	Category  string    `json:"category"`
	Name      string    `json:"name"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

type Ticket struct {
	ID         string     `json:"id"`
	UserID     *string    `json:"user_id,omitempty"`
	Subject    string     `json:"subject"`
	Body       string     `json:"body"`
	Status     string     `json:"status"`
	Priority   string     `json:"priority"`
	AssignedTo *string    `json:"assigned_to,omitempty"`
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

type AppVersion struct {
	ID           string    `json:"id"`
	Platform     string    `json:"platform"`
	MinVersion   string    `json:"min_version"`
	ForceUpdate  bool      `json:"force_update"`
	ForceMessage *string   `json:"force_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

type ChangelogEntry struct {
	ID          string     `json:"id"`
	Version     string     `json:"version"`
	Body        string     `json:"body"`
	IsPublished bool       `json:"is_published"`
	PublishedAt *time.Time `json:"published_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

type AuditRow struct {
	ID         int64           `json:"id"`
	AdminEmail *string         `json:"admin_email,omitempty"`
	Action     string          `json:"action"`
	Module     string          `json:"module"`
	TargetType *string         `json:"target_type,omitempty"`
	TargetID   *string         `json:"target_id,omitempty"`
	Before     json.RawMessage `json:"before,omitempty"`
	After      json.RawMessage `json:"after,omitempty"`
	IPAddress  *string         `json:"ip_address,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
}

// ── Service ────────────────────────────────────────────────────────────

type Service struct{ read, write *pgxpool.Pool }

func NewService(read, write *pgxpool.Pool) *Service { return &Service{read: read, write: write} }

// ── Webhooks ───────────────────────────────────────────────────────────

func (s *Service) ListWebhooks(ctx context.Context) ([]Webhook, error) {
	rows, err := s.read.Query(ctx, `
		SELECT id::text, url, events, is_active, created_at FROM crm_webhooks ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list webhooks: %w", err)
	}
	defer rows.Close()
	out := []Webhook{}
	for rows.Next() {
		var w Webhook
		if err := rows.Scan(&w.ID, &w.URL, &w.Events, &w.IsActive, &w.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

type WebhookCreate struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
	Secret string   `json:"secret"`
}

func (s *Service) CreateWebhook(ctx context.Context, req WebhookCreate, createdBy string) (string, error) {
	if !strings.HasPrefix(req.URL, "http") {
		return "", errors.New("url must start with http(s)")
	}
	if len(req.Events) == 0 {
		return "", errors.New("at least one event required")
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_webhooks (url, events, secret, created_by)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, '')::uuid)
		RETURNING id::text
	`, req.URL, req.Events, req.Secret, createdBy).Scan(&id)
	return id, err
}

func (s *Service) DeleteWebhook(ctx context.Context, id string) error {
	res, err := s.write.Exec(ctx, `DELETE FROM crm_webhooks WHERE id = $1::uuid`, id)
	if err != nil || res.RowsAffected() == 0 {
		return errors.New("not found")
	}
	return nil
}

func (s *Service) ListDeliveries(ctx context.Context, webhookID string) ([]WebhookDelivery, error) {
	rows, err := s.read.Query(ctx, `
		SELECT id, webhook_id::text, event, payload, status_code, succeeded, created_at
		FROM crm_webhook_deliveries
		WHERE webhook_id = $1::uuid
		ORDER BY created_at DESC LIMIT 50
	`, webhookID)
	if err != nil {
		return nil, fmt.Errorf("list deliveries: %w", err)
	}
	defer rows.Close()
	out := []WebhookDelivery{}
	for rows.Next() {
		var d WebhookDelivery
		if err := rows.Scan(&d.ID, &d.WebhookID, &d.Event, &d.Payload, &d.StatusCode, &d.Succeeded, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ── Templates ──────────────────────────────────────────────────────────

func (s *Service) ListTemplates(ctx context.Context) ([]Template, error) {
	rows, err := s.read.Query(ctx, `
		SELECT id::text, category, name, body, created_at FROM crm_response_templates ORDER BY category, name
	`)
	if err != nil {
		return nil, fmt.Errorf("list templates: %w", err)
	}
	defer rows.Close()
	out := []Template{}
	for rows.Next() {
		var t Template
		if err := rows.Scan(&t.ID, &t.Category, &t.Name, &t.Body, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

type TemplateRequest struct {
	Category, Name, Body string
}

func (s *Service) CreateTemplate(ctx context.Context, req TemplateRequest, createdBy string) (string, error) {
	if req.Category == "" || req.Name == "" || req.Body == "" {
		return "", errors.New("category, name, body required")
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_response_templates (category, name, body, created_by)
		VALUES ($1, $2, $3, NULLIF($4, '')::uuid) RETURNING id::text
	`, req.Category, req.Name, req.Body, createdBy).Scan(&id)
	return id, err
}

func (s *Service) UpdateTemplate(ctx context.Context, id string, req TemplateRequest) error {
	res, err := s.write.Exec(ctx, `
		UPDATE crm_response_templates SET category=$2, name=$3, body=$4, updated_at=now()
		WHERE id=$1::uuid
	`, id, req.Category, req.Name, req.Body)
	if err != nil || res.RowsAffected() == 0 {
		return errors.New("not found")
	}
	return nil
}

func (s *Service) DeleteTemplate(ctx context.Context, id string) error {
	res, err := s.write.Exec(ctx, `DELETE FROM crm_response_templates WHERE id=$1::uuid`, id)
	if err != nil || res.RowsAffected() == 0 {
		return errors.New("not found")
	}
	return nil
}

// ── Support Tickets ────────────────────────────────────────────────────

func (s *Service) ListTickets(ctx context.Context, status string, limit int) ([]Ticket, error) {
	if limit <= 0 {
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
		SELECT id::text, user_id::text, subject, body, status, priority, assigned_to::text,
		       resolved_at, created_at
		FROM crm_support_tickets %s ORDER BY created_at DESC LIMIT $%d
	`, cond, len(args)), args...)
	if err != nil {
		return nil, fmt.Errorf("list tickets: %w", err)
	}
	defer rows.Close()
	out := []Ticket{}
	for rows.Next() {
		var t Ticket
		if err := rows.Scan(&t.ID, &t.UserID, &t.Subject, &t.Body, &t.Status, &t.Priority,
			&t.AssignedTo, &t.ResolvedAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Service) ResolveTicket(ctx context.Context, id string) error {
	res, err := s.write.Exec(ctx, `
		UPDATE crm_support_tickets SET status='resolved', resolved_at=now(), updated_at=now()
		WHERE id=$1::uuid
	`, id)
	if err != nil || res.RowsAffected() == 0 {
		return errors.New("not found")
	}
	return nil
}

// ── App versions + changelog ───────────────────────────────────────────

func (s *Service) ListAppVersions(ctx context.Context) ([]AppVersion, error) {
	rows, err := s.read.Query(ctx, `
		SELECT id::text, platform, min_version, force_update, force_message, created_at
		FROM crm_app_versions ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list app versions: %w", err)
	}
	defer rows.Close()
	out := []AppVersion{}
	for rows.Next() {
		var v AppVersion
		if err := rows.Scan(&v.ID, &v.Platform, &v.MinVersion, &v.ForceUpdate, &v.ForceMessage, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type AppVersionRequest struct {
	Platform     string `json:"platform"`
	MinVersion   string `json:"min_version"`
	ForceUpdate  bool   `json:"force_update"`
	ForceMessage string `json:"force_message"`
}

func (s *Service) SetAppVersion(ctx context.Context, req AppVersionRequest, createdBy string) (string, error) {
	if req.Platform == "" || req.MinVersion == "" {
		return "", errors.New("platform and min_version required")
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_app_versions (platform, min_version, force_update, force_message, created_by)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, '')::uuid)
		RETURNING id::text
	`, req.Platform, req.MinVersion, req.ForceUpdate, req.ForceMessage, createdBy).Scan(&id)
	return id, err
}

func (s *Service) ListChangelog(ctx context.Context) ([]ChangelogEntry, error) {
	rows, err := s.read.Query(ctx, `
		SELECT id::text, version, body, is_published, published_at, created_at
		FROM crm_changelog ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list changelog: %w", err)
	}
	defer rows.Close()
	out := []ChangelogEntry{}
	for rows.Next() {
		var e ChangelogEntry
		if err := rows.Scan(&e.ID, &e.Version, &e.Body, &e.IsPublished, &e.PublishedAt, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

type ChangelogRequest struct {
	Version, Body string
	IsPublished   bool `json:"is_published"`
}

func (s *Service) CreateChangelog(ctx context.Context, req ChangelogRequest, createdBy string) (string, error) {
	if req.Version == "" || req.Body == "" {
		return "", errors.New("version and body required")
	}
	publishedAt := any(nil)
	if req.IsPublished {
		publishedAt = time.Now()
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_changelog (version, body, is_published, published_at, created_by)
		VALUES ($1, $2, $3, $4, NULLIF($5, '')::uuid) RETURNING id::text
	`, req.Version, req.Body, req.IsPublished, publishedAt, createdBy).Scan(&id)
	return id, err
}

// ── Audit log viewer ───────────────────────────────────────────────────

func (s *Service) ListAudit(ctx context.Context, module, action, adminEmail string, limit int) ([]AuditRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	args := []any{}
	conds := []string{"1=1"}
	if module != "" {
		args = append(args, module)
		conds = append(conds, fmt.Sprintf("module = $%d", len(args)))
	}
	if action != "" {
		args = append(args, action)
		conds = append(conds, fmt.Sprintf("action = $%d", len(args)))
	}
	if adminEmail != "" {
		args = append(args, adminEmail)
		conds = append(conds, fmt.Sprintf("admin_email = $%d", len(args)))
	}
	args = append(args, limit)
	rows, err := s.read.Query(ctx, fmt.Sprintf(`
		SELECT id, admin_email, action, module, target_type, target_id, before_value, after_value,
		       host(ip_address)::text, created_at
		FROM crm_audit_log WHERE %s ORDER BY created_at DESC LIMIT $%d
	`, strings.Join(conds, " AND "), len(args)), args...)
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var a AuditRow
		if err := rows.Scan(&a.ID, &a.AdminEmail, &a.Action, &a.Module, &a.TargetType, &a.TargetID,
			&a.Before, &a.After, &a.IPAddress, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
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
	w := r.Group("/webhooks")
	w.Get("/",                h.ListWebhooks)
	w.Post("/",               h.CreateWebhook)
	w.Delete("/:id",          h.DeleteWebhook)
	w.Get("/:id/deliveries",  h.ListDeliveries)

	t := r.Group("/templates")
	t.Get("/",     h.ListTemplates)
	t.Post("/",    h.CreateTemplate)
	t.Put("/:id",  h.UpdateTemplate)
	t.Delete("/:id", h.DeleteTemplate)

	s := r.Group("/support")
	s.Get("/",            h.ListTickets)
	s.Post("/:id/resolve", h.ResolveTicket)

	v := r.Group("/app-versions")
	v.Get("/",     h.ListAppVersions)
	v.Post("/",    h.SetAppVersion)

	cl := r.Group("/changelog")
	cl.Get("/",  h.ListChangelog)
	cl.Post("/", h.CreateChangelog)

	a := r.Group("/audit")
	a.Get("/", h.ListAudit)
}

func (h *Handler) ListWebhooks(c *fiber.Ctx) error {
	out, err := h.svc.ListWebhooks(c.Context())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateWebhook(c *fiber.Ctx) error {
	var req WebhookCreate
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	id, err := h.svc.CreateWebhook(c.Context(), req, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "webhook.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) DeleteWebhook(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.svc.DeleteWebhook(c.Context(), id); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "webhook.delete", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListDeliveries(c *fiber.Ctx) error {
	out, err := h.svc.ListDeliveries(c.Context(), c.Params("id"))
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) ListTemplates(c *fiber.Ctx) error {
	out, err := h.svc.ListTemplates(c.Context())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateTemplate(c *fiber.Ctx) error {
	var req TemplateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	id, err := h.svc.CreateTemplate(c.Context(), req, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "template.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) UpdateTemplate(c *fiber.Ctx) error {
	var req TemplateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	id := c.Params("id")
	if err := h.svc.UpdateTemplate(c.Context(), id, req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "template.update", id, nil, req)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) DeleteTemplate(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.svc.DeleteTemplate(c.Context(), id); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "template.delete", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListTickets(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	out, err := h.svc.ListTickets(c.Context(), c.Query("status"), limit)
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) ResolveTicket(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.svc.ResolveTicket(c.Context(), id); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "ticket.resolve", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListAppVersions(c *fiber.Ctx) error {
	out, err := h.svc.ListAppVersions(c.Context())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) SetAppVersion(c *fiber.Ctx) error {
	var req AppVersionRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	id, err := h.svc.SetAppVersion(c.Context(), req, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "appversion.set", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) ListChangelog(c *fiber.Ctx) error {
	out, err := h.svc.ListChangelog(c.Context())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateChangelog(c *fiber.Ctx) error {
	var req ChangelogRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	id, err := h.svc.CreateChangelog(c.Context(), req, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "changelog.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) ListAudit(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "100"))
	out, err := h.svc.ListAudit(c.Context(),
		c.Query("module"), c.Query("action"), c.Query("admin_email"), limit)
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.Context(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "platform",
		TargetType: "platform", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}

func jsonOrErr(c *fiber.Ctx, payload any, err error) error {
	if err != nil {
		log.Error().Err(err).Msg("[crm.platform] query failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(payload)
}
