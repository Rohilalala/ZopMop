// Package notifications is the per-admin CRM notification centre. Module
// callers push entries via Recorder.Push; the SPA polls the bell-icon feed
// and marks entries read individually.
//
// This is intentionally separate from `crm/alerts` — alerts are the legacy
// dashboard system feed, notifications are addressable, urgent-flaggable and
// linked to a specific record (entity_type + entity_id).
package notifications

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

// Severity classifies a notification. `urgent` rows render red and are
// excluded from any UI auto-dismiss.
type Severity string

const (
	SeverityInfo    Severity = "info"
	SeverityWarning Severity = "warning"
	SeverityUrgent  Severity = "urgent"
)

func (s Severity) valid() bool {
	return s == SeverityInfo || s == SeverityWarning || s == SeverityUrgent
}

// Notification is a single feed row.
type Notification struct {
	ID         int64      `json:"id"`
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	Severity   Severity   `json:"severity"`
	EntityType *string    `json:"entity_type,omitempty"`
	EntityID   *string    `json:"entity_id,omitempty"`
	ReadAt     *time.Time `json:"read_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

// Recorder writes notifications. Failures are logged, never propagated —
// notification writes must not break the operation that emitted them.
type Recorder struct {
	db *pgxpool.Pool
}

// NewRecorder constructs a Recorder.
func NewRecorder(db *pgxpool.Pool) *Recorder { return &Recorder{db: db} }

// Push inserts one notification. entityType/entityID may be empty.
func (r *Recorder) Push(ctx context.Context, sev Severity, title, body, entityType, entityID string) {
	if r == nil || r.db == nil {
		return
	}
	if !sev.valid() {
		sev = SeverityInfo
	}
	var (
		etArg any = nil
		eiArg any = nil
	)
	if entityType != "" {
		etArg = entityType
	}
	if entityID != "" {
		eiArg = entityID
	}
	if _, err := r.db.Exec(ctx, `
		INSERT INTO crm_notifications (title, body, severity, entity_type, entity_id)
		VALUES ($1, $2, $3, $4, $5)
	`, title, body, string(sev), etArg, eiArg); err != nil {
		log.Error().Err(err).Str("title", title).Msg("[crm.notifications] push failed")
	}
}

// Service handles reads + mark-read writes.
type Service struct {
	db *pgxpool.Pool
}

// NewService constructs the Service.
func NewService(db *pgxpool.Pool) *Service { return &Service{db: db} }

// List returns the most recent notifications. limit clamped to [1, 200].
// onlyUnread filters to read_at IS NULL.
func (s *Service) List(ctx context.Context, limit int, onlyUnread bool) ([]Notification, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `
		SELECT id, title, body, severity, entity_type, entity_id, read_at, created_at
		FROM crm_notifications
	`
	if onlyUnread {
		q += ` WHERE read_at IS NULL `
	}
	q += ` ORDER BY created_at DESC LIMIT $1 `

	rows, err := s.db.Query(ctx, q, limit)
	if err != nil {
		return nil, fmt.Errorf("list notifications: %w", err)
	}
	defer rows.Close()

	out := []Notification{}
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.Title, &n.Body, &n.Severity, &n.EntityType, &n.EntityID, &n.ReadAt, &n.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan notification: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// UnreadCount returns the number of notifications with read_at IS NULL.
func (s *Service) UnreadCount(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT COUNT(*) FROM crm_notifications WHERE read_at IS NULL`).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("unread count: %w", err)
	}
	return n, nil
}

// MarkRead stamps read_at = NOW() on a single notification. Idempotent.
func (s *Service) MarkRead(ctx context.Context, id int64) error {
	res, err := s.db.Exec(ctx, `
		UPDATE crm_notifications SET read_at = NOW()
		WHERE id = $1 AND read_at IS NULL
	`, id)
	if err != nil {
		return fmt.Errorf("mark read: %w", err)
	}
	if res.RowsAffected() == 0 {
		// Already read or doesn't exist — verify which.
		var exists bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM crm_notifications WHERE id = $1)`, id).Scan(&exists); err == nil && !exists {
			return errors.New("notification not found")
		}
	}
	return nil
}

// MarkAllRead bulk-marks every unread notification as read.
func (s *Service) MarkAllRead(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `UPDATE crm_notifications SET read_at = NOW() WHERE read_at IS NULL`)
	if err != nil {
		return fmt.Errorf("mark all read: %w", err)
	}
	return nil
}

// Handler is the HTTP layer.
type Handler struct {
	svc *Service
}

// NewHandler constructs a Handler.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterRoutes mounts /notifications/* under the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	read := middleware.RequirePermission("notifications.read")
	r.Get("/notifications", read, h.List)
	r.Get("/notifications/unread-count", read, h.UnreadCount)
	r.Post("/notifications/:id/read", h.MarkRead)
	r.Post("/notifications/read-all", h.MarkAllRead)
}

// List handles GET /notifications?limit=&unread=true.
func (h *Handler) List(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	onlyUnread := strings.EqualFold(c.Query("unread"), "true")
	out, err := h.svc.List(c.UserContext(), limit, onlyUnread)
	if err != nil {
		log.Error().Err(err).Msg("[crm.notifications] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": out})
}

// UnreadCount handles GET /notifications/unread-count.
func (h *Handler) UnreadCount(c *fiber.Ctx) error {
	n, err := h.svc.UnreadCount(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.notifications] unread-count failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"unread": n})
}

// MarkRead handles POST /notifications/:id/read.
func (h *Handler) MarkRead(c *fiber.Ctx) error {
	id, err := strconv.ParseInt(c.Params("id"), 10, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.MarkRead(c.UserContext(), id); err != nil {
		if err.Error() == "notification not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "notification not found"})
		}
		log.Error().Err(err).Int64("id", id).Msg("[crm.notifications] mark read failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"ok": true})
}

// MarkAllRead handles POST /notifications/read-all.
func (h *Handler) MarkAllRead(c *fiber.Ctx) error {
	if err := h.svc.MarkAllRead(c.UserContext()); err != nil {
		log.Error().Err(err).Msg("[crm.notifications] mark-all-read failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"ok": true})
}

