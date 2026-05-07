// Package leaves is the CRM-side leave management view. It reads from the
// existing `pro_leaves` table (declared by pros via the helper-app leave
// flow) and the `helpers` balance columns, exposing a list with reassignment
// outcomes and an admin allocation endpoint.
package leaves

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
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

// LeaveRow is one row in the CRM leaves table.
type LeaveRow struct {
	ID                   string    `json:"id"`
	ProID                string    `json:"pro_id"`
	ProName              string    `json:"pro_name"`
	ProPhone             string    `json:"pro_phone"`
	Date                 time.Time `json:"date"`
	DeclaredAt           time.Time `json:"declared_at"`
	Status               string    `json:"status"`
	Source               string    `json:"source"`
	BookingsAffected     int       `json:"bookings_affected"`
	ReassignmentOutcome  string    `json:"reassignment_outcome"`
	CancelledBookingIDs  []string  `json:"cancelled_booking_ids"`
}

// Balance is the per-pro monthly balance row shown next to the table.
type Balance struct {
	ProID        string    `json:"pro_id"`
	ProName      string    `json:"pro_name"`
	ProPhone     string    `json:"pro_phone"`
	Balance      int       `json:"balance"`
	MonthlyQuota int       `json:"monthly_quota"`
	UsedThisMonth int      `json:"used_this_month"`
	ResetAt      time.Time `json:"reset_at"`
}

// AllocateRequest is the input to POST /pro/:id/leave/allocate.
type AllocateRequest struct {
	Days   int    `json:"days"`
	Reason string `json:"reason"`
}

// ListFilters narrows the leaves listing.
type ListFilters struct {
	ProID    string
	From     *time.Time
	To       *time.Time
	Limit    int
	Offset   int
}

// Repository handles all DB access.
type Repository struct {
	read, write *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

// List returns leave declarations matching the filters, newest first.
func (r *Repository) List(ctx context.Context, f ListFilters) ([]LeaveRow, int, error) {
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 50
	}
	if f.Offset < 0 {
		f.Offset = 0
	}

	args := []any{}
	wheres := []string{"1=1"}
	if f.ProID != "" {
		args = append(args, f.ProID)
		wheres = append(wheres, fmt.Sprintf("pl.pro_id = $%d", len(args)))
	}
	if f.From != nil {
		args = append(args, *f.From)
		wheres = append(wheres, fmt.Sprintf("pl.date >= $%d", len(args)))
	}
	if f.To != nil {
		args = append(args, *f.To)
		wheres = append(wheres, fmt.Sprintf("pl.date <= $%d", len(args)))
	}
	whereSQL := strings.Join(wheres, " AND ")

	var total int
	if err := r.read.QueryRow(ctx,
		`SELECT COUNT(*) FROM pro_leaves pl WHERE `+whereSQL,
		args...,
	).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count leaves: %w", err)
	}

	args = append(args, f.Limit, f.Offset)
	limitIdx := len(args) - 1
	offsetIdx := len(args)

	q := fmt.Sprintf(`
		SELECT pl.id::text, pl.pro_id::text,
		       COALESCE(u.name, ''), u.phone,
		       pl.date, pl.declared_at, pl.status, pl.source,
		       pl.bookings_affected, pl.reassignment_outcome,
		       COALESCE(pl.cancelled_booking_ids::text[], '{}'::text[])
		FROM pro_leaves pl
		LEFT JOIN users u ON u.id = pl.pro_id AND u.deleted_at IS NULL
		WHERE %s
		ORDER BY pl.date DESC, pl.declared_at DESC
		LIMIT $%d OFFSET $%d`, whereSQL, limitIdx, offsetIdx)

	rows, err := r.read.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list leaves: %w", err)
	}
	defer rows.Close()

	out := []LeaveRow{}
	for rows.Next() {
		var lr LeaveRow
		if err := rows.Scan(&lr.ID, &lr.ProID, &lr.ProName, &lr.ProPhone,
			&lr.Date, &lr.DeclaredAt, &lr.Status, &lr.Source,
			&lr.BookingsAffected, &lr.ReassignmentOutcome, &lr.CancelledBookingIDs,
		); err != nil {
			return nil, 0, fmt.Errorf("scan leave: %w", err)
		}
		out = append(out, lr)
	}
	return out, total, rows.Err()
}

// Balances returns the per-pro balance + this-month usage. Limited to pros
// who actually have a helpers row (so the join doesn't return customers).
func (r *Repository) Balances(ctx context.Context, proID string) ([]Balance, error) {
	args := []any{}
	where := ""
	if proID != "" {
		args = append(args, proID)
		where = "WHERE h.id = $1"
	}
	q := fmt.Sprintf(`
		SELECT h.id::text, COALESCE(u.name, ''), u.phone,
		       h.leave_balance, h.monthly_leave_quota, h.leave_balance_reset_at,
		       COALESCE((
		         SELECT COUNT(*) FROM pro_leaves pl
		         WHERE pl.pro_id = h.id
		           AND pl.status = 'approved'
		           AND pl.date >= date_trunc('month', now())
		           AND pl.date <  date_trunc('month', now()) + INTERVAL '1 month'
		       ), 0) AS used_this_month
		FROM helpers h
		LEFT JOIN users u ON u.id = h.id AND u.deleted_at IS NULL
		%s
		ORDER BY u.name NULLS LAST
		LIMIT 500`, where)

	rows, err := r.read.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list balances: %w", err)
	}
	defer rows.Close()

	out := []Balance{}
	for rows.Next() {
		var b Balance
		if err := rows.Scan(&b.ProID, &b.ProName, &b.ProPhone,
			&b.Balance, &b.MonthlyQuota, &b.ResetAt, &b.UsedThisMonth); err != nil {
			return nil, fmt.Errorf("scan balance: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ErrProNotFound is returned by Allocate when the pro id does not match a helper row.
var ErrProNotFound = errors.New("pro not found")

// Allocate adds `days` to the pro's running leave_balance. Returns the new
// balance. Also writes an audit row through the caller, not here.
func (r *Repository) Allocate(ctx context.Context, proID string, days int) (int, error) {
	if days <= 0 {
		return 0, errors.New("days must be > 0")
	}
	var newBalance int
	err := r.write.QueryRow(ctx, `
		UPDATE helpers
		SET leave_balance = leave_balance + $2
		WHERE id = $1
		RETURNING leave_balance
	`, proID, days).Scan(&newBalance)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrProNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("allocate leave: %w", err)
	}
	return newBalance, nil
}

// Service wraps the repo + the audit recorder.
type Service struct {
	repo *Repository
}

// NewService constructs a Service.
func NewService(repo *Repository) *Service { return &Service{repo: repo} }

// List proxies to the repo.
func (s *Service) List(ctx context.Context, f ListFilters) ([]LeaveRow, int, error) {
	return s.repo.List(ctx, f)
}

// Balances proxies to the repo.
func (s *Service) Balances(ctx context.Context, proID string) ([]Balance, error) {
	return s.repo.Balances(ctx, proID)
}

// Allocate proxies to the repo.
func (s *Service) Allocate(ctx context.Context, proID string, days int) (int, error) {
	return s.repo.Allocate(ctx, proID, days)
}

// Handler is the HTTP layer.
type Handler struct {
	svc      *Service
	recorder *audit.Recorder
}

// NewHandler constructs a Handler.
func NewHandler(svc *Service, recorder *audit.Recorder) *Handler {
	return &Handler{svc: svc, recorder: recorder}
}

// RegisterRoutes mounts:
//   GET  /leaves                    — list w/ filters
//   GET  /leaves/balances           — per-pro balance
//   POST /pro/:id/leave/allocate    — allocate extra days (audited)
func (h *Handler) RegisterRoutes(r fiber.Router) {
	read := middleware.RequirePermission("leaves.read")
	r.Get("/leaves", read, h.List)
	r.Get("/leaves/balances", read, h.Balances)
	r.Post("/pro/:id/leave/allocate", middleware.RequirePermission("workers.update"), h.Allocate)
}

// List handles GET /leaves?pro_id=&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=&offset=.
func (h *Handler) List(c *fiber.Ctx) error {
	f := ListFilters{
		ProID: c.Query("pro_id"),
	}
	if v := c.Query("from"); v != "" {
		if t, err := time.Parse("2006-01-02", v); err == nil {
			f.From = &t
		}
	}
	if v := c.Query("to"); v != "" {
		if t, err := time.Parse("2006-01-02", v); err == nil {
			f.To = &t
		}
	}
	f.Limit, _ = strconv.Atoi(c.Query("limit", "50"))
	f.Offset, _ = strconv.Atoi(c.Query("offset", "0"))

	rows, total, err := h.svc.List(c.UserContext(), f)
	if err != nil {
		log.Error().Err(err).Msg("[crm.leaves] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{
		"items":       rows,
		"total_count": total,
		"limit":       f.Limit,
		"offset":      f.Offset,
	})
}

// Balances handles GET /leaves/balances?pro_id=.
func (h *Handler) Balances(c *fiber.Ctx) error {
	out, err := h.svc.Balances(c.UserContext(), c.Query("pro_id"))
	if err != nil {
		log.Error().Err(err).Msg("[crm.leaves] balances failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": out})
}

// Allocate handles POST /pro/:id/leave/allocate.
func (h *Handler) Allocate(c *fiber.Ctx) error {
	proID := c.Params("id")
	if proID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing pro id"})
	}

	var req AllocateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if req.Days <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "days must be > 0"})
	}

	newBalance, err := h.svc.Allocate(c.UserContext(), proID, req.Days)
	if err != nil {
		if errors.Is(err, ErrProNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "pro not found"})
		}
		log.Error().Err(err).Str("pro_id", proID).Msg("[crm.leaves] allocate failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	if h.recorder != nil {
		adminID, _ := c.Locals("crmAdminID").(string)
		adminEmail, _ := c.Locals("crmAdminEmail").(string)
		h.recorder.Log(c.UserContext(), audit.Entry{
			AdminID: adminID, AdminEmail: adminEmail,
			Action: "leave.allocate", Module: "leaves",
			TargetType: "pro", TargetID: proID,
			Before: nil, After: req,
			IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
		})
	}

	return c.JSON(fiber.Map{
		"ok":          true,
		"new_balance": newBalance,
	})
}
