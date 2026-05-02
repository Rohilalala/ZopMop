// Package alerts is the CRM dashboard alert feed. Module-internal callers
// (flags, workers, fraud, etc.) push entries via Recorder.Push; the handler
// exposes List / MarkRead.
package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Severity classifies an alert. Maps to colour in the UI.
type Severity string

const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
	SeverityInfo    Severity = "info"
)

// Entry is a single alert row.
type Entry struct {
	ID        int64           `json:"id"`
	Severity  Severity        `json:"severity"`
	Source    string          `json:"source"`
	Message   string          `json:"message"`
	Link      *string         `json:"link,omitempty"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	ReadBy    json.RawMessage `json:"read_by"`
	CreatedAt time.Time       `json:"created_at"`
}

// Recorder writes alerts.
type Recorder struct {
	db *pgxpool.Pool
}

// NewRecorder constructs the Recorder.
func NewRecorder(db *pgxpool.Pool) *Recorder { return &Recorder{db: db} }

// Push inserts a single alert. Failures are logged, not propagated.
func (r *Recorder) Push(ctx context.Context, sev Severity, source, message, link string, metadata any) {
	if r == nil || r.db == nil {
		return
	}
	var (
		linkArg any = nil
		metaArg any = nil
	)
	if link != "" {
		linkArg = link
	}
	if metadata != nil {
		b, err := json.Marshal(metadata)
		if err == nil {
			metaArg = b
		}
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO crm_alerts (severity, source, message, link, metadata)
		VALUES ($1, $2, $3, $4, $5)
	`, string(sev), source, message, linkArg, metaArg)
	if err != nil {
		log.Error().Err(err).Str("source", source).Msg("[crm.alerts] push failed")
	}
}

// Service handles alert queries. Reads only.
type Service struct {
	db *pgxpool.Pool
}

// NewService constructs the alerts query Service.
func NewService(db *pgxpool.Pool) *Service { return &Service{db: db} }

// List returns the most recent alerts. limit clamped to [1, 200].
func (s *Service) List(ctx context.Context, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, severity, source, message, link, metadata, read_by, created_at
		FROM crm_alerts
		ORDER BY created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list alerts: %w", err)
	}
	defer rows.Close()

	out := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.Severity, &e.Source, &e.Message, &e.Link, &e.Metadata, &e.ReadBy, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan alert: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkAllRead appends adminID to every alert's read_by JSON array (idempotent).
func (s *Service) MarkAllRead(ctx context.Context, adminID string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE crm_alerts
		SET read_by = (
		  CASE
		    WHEN read_by ? $1 THEN read_by
		    ELSE read_by || to_jsonb($1::text)
		  END
		)
	`, adminID)
	if err != nil {
		return fmt.Errorf("mark all read: %w", err)
	}
	return nil
}

// Handler is the HTTP layer for alerts.
type Handler struct {
	svc *Service
}

// NewHandler constructs the alerts Handler.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterRoutes mounts /alerts/* under the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Get("/alerts", h.List)
	r.Post("/alerts/read-all", h.MarkAllRead)
}

// List returns recent alerts.
func (h *Handler) List(c *fiber.Ctx) error {
	out, err := h.svc.List(c.Context(), 100)
	if err != nil {
		log.Error().Err(err).Msg("[crm.alerts] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"alerts": out})
}

// MarkAllRead is POST /alerts/read-all.
func (h *Handler) MarkAllRead(c *fiber.Ctx) error {
	adminID, _ := c.Locals("crmAdminID").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	if err := h.svc.MarkAllRead(c.Context(), adminID); err != nil {
		log.Error().Err(err).Msg("[crm.alerts] mark all read failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"ok": true})
}
