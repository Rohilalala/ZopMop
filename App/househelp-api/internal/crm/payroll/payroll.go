// Package payroll surfaces the payroll engine to CRM admins:
// per-worker payout history, mark-paid / mark-failed reversal,
// and single-row recompute. All status-changing actions write a
// payout_audit_log row inside the same transaction as the data
// mutation so the history is always consistent.
package payroll

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
	crmmw "github.com/adityarohilla/househelp-api/internal/crm/middleware"
	payengine "github.com/adityarohilla/househelp-api/internal/payroll"
)

// ─── Errors ────────────────────────────────────────────────────────

var (
	ErrPayoutNotFound    = errors.New("payout not found")
	ErrInvalidTransition = errors.New("invalid status transition")
	ErrPaidRowImmutable  = errors.New("paid rows are immutable; mark-failed first")
	ErrMissingRequired   = errors.New("missing required field")
	ErrFieldTooLong      = errors.New("field exceeds length limit")
)

// ─── Models ────────────────────────────────────────────────────────

// Payout is one row in the payouts table, joined with helper name +
// phone for the CRM drawer view.
type Payout struct {
	ID              string     `json:"id"`
	ProID           string     `json:"pro_id"`
	HelperName      *string    `json:"helper_name,omitempty"`
	HelperPhone     *string    `json:"helper_phone,omitempty"`
	CycleStart      string     `json:"cycle_start"` // YYYY-MM-DD
	CycleEnd        string     `json:"cycle_end"`   // YYYY-MM-DD
	OnlineMinutes   int        `json:"online_minutes"`
	WorkingMinutes  int        `json:"working_minutes"`
	BasePayPaise    int64      `json:"base_pay_paise"`
	WorkBonusPaise  int64      `json:"work_bonus_paise"`
	GrossPayPaise   int64      `json:"gross_pay_paise"`
	DeductionsPaise int64      `json:"deductions_paise"`
	NetPayPaise     int64      `json:"net_pay_paise"`
	Status          string     `json:"status"`
	TransactionID   *string    `json:"transaction_id,omitempty"`
	PaidAt          *time.Time `json:"paid_at,omitempty"`
	PaidByAdminID   *string    `json:"paid_by_admin_id,omitempty"`
	FailureReason   *string    `json:"failure_reason,omitempty"`
	Notes           *string    `json:"notes,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// WorkerPayoutSummary is the GET /workers/:id/payroll-payouts shape.
type WorkerPayoutSummary struct {
	LifetimePaidPaise   int64    `json:"lifetime_paid_paise"`
	CurrentCyclePending *Payout  `json:"current_cycle_pending,omitempty"`
	RecentPayouts       []Payout `json:"recent_payouts"`
}

// ─── Repository ────────────────────────────────────────────────────

type Repository struct {
	read  *pgxpool.Pool
	write *pgxpool.Pool
}

func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

const payoutSelect = `
	SELECT p.id::text,
	       p.pro_id::text,
	       u.name,
	       u.phone,
	       to_char(p.cycle_start, 'YYYY-MM-DD'),
	       to_char(p.cycle_end,   'YYYY-MM-DD'),
	       p.online_minutes,
	       p.working_minutes,
	       p.base_pay_paise,
	       p.work_bonus_paise,
	       p.gross_pay_paise,
	       p.deductions_paise,
	       p.net_pay_paise,
	       p.status,
	       p.transaction_id,
	       p.paid_at,
	       p.paid_by_admin_id::text,
	       p.failure_reason,
	       p.notes,
	       p.created_at,
	       p.updated_at
	  FROM payouts p
	  LEFT JOIN users u ON u.id = p.pro_id AND u.deleted_at IS NULL`

func scanPayout(row pgx.Row) (*Payout, error) {
	var p Payout
	if err := row.Scan(
		&p.ID, &p.ProID, &p.HelperName, &p.HelperPhone,
		&p.CycleStart, &p.CycleEnd,
		&p.OnlineMinutes, &p.WorkingMinutes,
		&p.BasePayPaise, &p.WorkBonusPaise, &p.GrossPayPaise,
		&p.DeductionsPaise, &p.NetPayPaise,
		&p.Status, &p.TransactionID, &p.PaidAt, &p.PaidByAdminID,
		&p.FailureReason, &p.Notes,
		&p.CreatedAt, &p.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &p, nil
}

func (r *Repository) WorkerSummary(ctx context.Context, proID string, today time.Time) (*WorkerPayoutSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	out := &WorkerPayoutSummary{RecentPayouts: []Payout{}}

	if err := r.read.QueryRow(ctx, `
		SELECT COALESCE(SUM(net_pay_paise), 0)
		  FROM payouts
		 WHERE pro_id = $1::uuid AND status = 'paid'
	`, proID).Scan(&out.LifetimePaidPaise); err != nil {
		return nil, fmt.Errorf("lifetime sum: %w", err)
	}

	rows, err := r.read.Query(ctx, payoutSelect+`
		 WHERE p.pro_id = $1::uuid
		 ORDER BY p.cycle_start DESC
		 LIMIT 12
	`, proID)
	if err != nil {
		return nil, fmt.Errorf("recent payouts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		p, err := scanPayout(rows)
		if err != nil {
			return nil, err
		}
		out.RecentPayouts = append(out.RecentPayouts, *p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Current-cycle pending = the row whose cycle window contains
	// today AND status='pending_manual_payout'. There's at most one
	// per pro per cycle (UNIQUE on pro_id, cycle_start).
	currentPending, err := r.read.Query(ctx, payoutSelect+`
		 WHERE p.pro_id = $1::uuid
		   AND p.status = 'pending_manual_payout'
		   AND $2::date BETWEEN p.cycle_start AND p.cycle_end
		 LIMIT 1
	`, proID, today.Format("2006-01-02"))
	if err != nil {
		return nil, fmt.Errorf("current cycle pending: %w", err)
	}
	defer currentPending.Close()
	if currentPending.Next() {
		p, err := scanPayout(currentPending)
		if err != nil {
			return nil, err
		}
		out.CurrentCyclePending = p
	}

	return out, nil
}

func (r *Repository) GetByID(ctx context.Context, id string) (*Payout, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	row := r.read.QueryRow(ctx, payoutSelect+` WHERE p.id = $1::uuid`, id)
	p, err := scanPayout(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPayoutNotFound
	}
	return p, err
}

// MarkPaid transitions pending_manual_payout → paid in one
// transaction with the audit log insert. The returned Payout is
// read via the same transaction (not the read pool) so callers
// never observe replica-lag staleness on the response.
func (r *Repository) MarkPaid(ctx context.Context, id, adminID string, paidAt time.Time, notes string) (*Payout, error) {
	if adminID == "" {
		return nil, fmt.Errorf("%w: admin_id (JWT locals not set?)", ErrMissingRequired)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.write.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	before, after, err := r.transitionInTx(ctx, tx, id, "mark_paid", "pending_manual_payout", `
		UPDATE payouts
		   SET status            = 'paid',
		       paid_at           = $2,
		       paid_by_admin_id  = $3::uuid,
		       notes             = COALESCE(NULLIF($4, ''), notes),
		       updated_at        = now()
		 WHERE id = $1::uuid
		   AND status = 'pending_manual_payout'
		RETURNING id
	`, id, paidAt, adminID, notes)
	if err != nil {
		return nil, err
	}

	if err := insertAudit(ctx, tx, id, adminID, "mark_paid", before, after, notes); err != nil {
		return nil, fmt.Errorf("audit log: %w", err)
	}
	out, err := selectPayoutByIDTx(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// MarkFailed transitions pending_manual_payout OR paid → failed.
// paid_at is preserved (not nulled) so the audit trail survives.
func (r *Repository) MarkFailed(ctx context.Context, id, adminID, reason string) (*Payout, error) {
	if adminID == "" {
		return nil, fmt.Errorf("%w: admin_id (JWT locals not set?)", ErrMissingRequired)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.write.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Allow from pending_manual_payout OR paid. The WHERE clause
	// holds the gate; the SET clause leaves paid_at and
	// paid_by_admin_id untouched so reversal preserves who paid
	// and when, just flipping the status.
	before, after, err := r.transitionInTx(ctx, tx, id, "mark_failed", "pending_manual_payout|paid", `
		UPDATE payouts
		   SET status         = 'failed',
		       failure_reason = $2,
		       updated_at     = now()
		 WHERE id = $1::uuid
		   AND status IN ('pending_manual_payout', 'paid')
		RETURNING id
	`, id, reason)
	if err != nil {
		return nil, err
	}

	if err := insertAudit(ctx, tx, id, adminID, "mark_failed", before, after, reason); err != nil {
		return nil, fmt.Errorf("audit log: %w", err)
	}
	out, err := selectPayoutByIDTx(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RecomputeApply UPDATEs an existing row in-place with fresh pay
// figures. Allowed only when status ∈ {pending_manual_payout,
// failed}. Caller computes the PayBreakdown from the payroll
// engine; this method writes it and the audit row in one tx.
func (r *Repository) RecomputeApply(ctx context.Context, id, adminID string, p payengine.PayBreakdown) (*Payout, error) {
	if adminID == "" {
		return nil, fmt.Errorf("%w: admin_id (JWT locals not set?)", ErrMissingRequired)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.write.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	before, after, err := r.transitionInTx(ctx, tx, id, "recomputed", "pending_manual_payout|failed", `
		UPDATE payouts
		   SET online_minutes   = $2,
		       working_minutes  = $3,
		       base_pay_paise   = $4,
		       work_bonus_paise = $5,
		       gross_pay_paise  = $6,
		       net_pay_paise    = $7,
		       updated_at       = now()
		 WHERE id = $1::uuid
		   AND status IN ('pending_manual_payout', 'failed')
		RETURNING id
	`, id, p.OnlineMinutes, p.WorkingMinutes,
		p.BasePayPaise, p.BonusPayPaise, p.GrossPayPaise, p.NetPayPaise)
	if err != nil {
		return nil, err
	}

	if err := insertAudit(ctx, tx, id, adminID, "recomputed", before, after, ""); err != nil {
		return nil, fmt.Errorf("audit log: %w", err)
	}
	out, err := selectPayoutByIDTx(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// selectPayoutByIDTx reads the row inside the current transaction
// so the returned snapshot reflects committed-on-this-tx state,
// not whatever a possibly-lagged read replica returns.
func selectPayoutByIDTx(ctx context.Context, tx pgx.Tx, id string) (*Payout, error) {
	row := tx.QueryRow(ctx, payoutSelect+` WHERE p.id = $1::uuid`, id)
	p, err := scanPayout(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrPayoutNotFound
	}
	return p, err
}

// transitionInTx is the shared core: SELECT the existing row for
// before_state, run the conditional UPDATE, SELECT the new row for
// after_state. If the UPDATE matched zero rows the transition was
// invalid (wrong starting status, or row doesn't exist).
func (r *Repository) transitionInTx(ctx context.Context, tx pgx.Tx, id, action, allowed, updateSQL string, args ...any) (before, after map[string]any, err error) {
	before, err = readPayoutSnapshot(ctx, tx, id)
	if err != nil {
		return nil, nil, err
	}
	if before == nil {
		return nil, nil, ErrPayoutNotFound
	}

	tag, err := tx.Exec(ctx, updateSQL, args...)
	if err != nil {
		return nil, nil, err
	}
	if tag.RowsAffected() == 0 {
		// Specific path: action=recomputed on a paid row → 403
		// upstream. Otherwise it's a generic 409 invalid transition.
		curr, _ := before["status"].(string)
		if action == "recomputed" && curr == "paid" {
			return nil, nil, ErrPaidRowImmutable
		}
		return nil, nil, fmt.Errorf("%w: action=%s allowed_from=%s current=%s", ErrInvalidTransition, action, allowed, curr)
	}

	after, err = readPayoutSnapshot(ctx, tx, id)
	if err != nil {
		return nil, nil, err
	}
	return before, after, nil
}

// readPayoutSnapshot reads the row inside the caller's transaction
// with FOR UPDATE so a concurrent mutation cannot interleave between
// the snapshot read and the conditional UPDATE. Returns nil, nil
// when the row does not exist.
func readPayoutSnapshot(ctx context.Context, tx pgx.Tx, id string) (map[string]any, error) {
	var status string
	var (
		online, working                      int
		base, bonus, gross, deduct, net      int64
		txnID, failure, notes, paidByAdminID *string
		paidAt                               *time.Time
		cycleStart, cycleEnd                 time.Time
	)
	err := tx.QueryRow(ctx, `
		SELECT status, online_minutes, working_minutes,
		       base_pay_paise, work_bonus_paise, gross_pay_paise,
		       deductions_paise, net_pay_paise,
		       transaction_id, failure_reason, notes,
		       paid_by_admin_id::text, paid_at,
		       cycle_start, cycle_end
		  FROM payouts WHERE id = $1::uuid
		  FOR UPDATE
	`, id).Scan(&status, &online, &working,
		&base, &bonus, &gross, &deduct, &net,
		&txnID, &failure, &notes,
		&paidByAdminID, &paidAt,
		&cycleStart, &cycleEnd,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	snap := map[string]any{
		"status":           status,
		"online_minutes":   online,
		"working_minutes":  working,
		"base_pay_paise":   base,
		"work_bonus_paise": bonus,
		"gross_pay_paise":  gross,
		"deductions_paise": deduct,
		"net_pay_paise":    net,
		"transaction_id":   txnID,
		"failure_reason":   failure,
		"notes":            notes,
		"paid_by_admin_id": paidByAdminID,
		"paid_at":          paidAt,
		"cycle_start":      cycleStart.Format("2006-01-02"),
		"cycle_end":        cycleEnd.Format("2006-01-02"),
	}
	return snap, nil
}

func insertAudit(ctx context.Context, tx pgx.Tx, payoutID, adminID, action string, before, after map[string]any, notes string) error {
	beforeJSON, err := json.Marshal(before)
	if err != nil {
		return err
	}
	afterJSON, err := json.Marshal(after)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO payout_audit_log (payout_id, admin_id, action, before_state, after_state, notes)
		VALUES ($1::uuid, NULLIF($2, '')::uuid, $3, $4::jsonb, $5::jsonb, NULLIF($6, ''))
	`, payoutID, adminID, action, beforeJSON, afterJSON, notes)
	return err
}

// CycleBounds reads the cycle window stored on a payout row. The
// CRM recompute handler uses this to feed payengine.ComputeForHelper
// without trusting the request body.
func (r *Repository) CycleBounds(ctx context.Context, id string) (payengine.CycleClose, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var (
		cs, ce time.Time
		proID  string
	)
	err := r.read.QueryRow(ctx, `
		SELECT pro_id::text, cycle_start, cycle_end
		  FROM payouts WHERE id = $1::uuid
	`, id).Scan(&proID, &cs, &ce)
	if errors.Is(err, pgx.ErrNoRows) {
		return payengine.CycleClose{}, "", ErrPayoutNotFound
	}
	if err != nil {
		return payengine.CycleClose{}, "", err
	}
	loc := payengine.Location()
	return payengine.CycleClose{
		Start: time.Date(cs.Year(), cs.Month(), cs.Day(), 0, 0, 0, 0, loc),
		End:   time.Date(ce.Year(), ce.Month(), ce.Day(), 0, 0, 0, 0, loc),
	}, proID, nil
}

// ─── Handler ───────────────────────────────────────────────────────

type Handler struct {
	repo     *Repository
	engine   *payengine.Service
	recorder *audit.Recorder
}

func NewHandler(repo *Repository, engine *payengine.Service, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, engine: engine, recorder: recorder}
}

// RegisterRoutes mounts the CRM payroll admin surface. Worker
// summary lives under /workers/:id so it sits next to the other
// worker drawer reads; per-payout mutations live under
// /payroll/payouts/:id so they don't collide with the legacy
// /payouts/:id namespace used by the manual crm_payouts table.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Get("/workers/:id/payroll-payouts",
		crmmw.RequirePermission("payouts.read"), h.WorkerSummary)

	g := r.Group("/payroll")
	g.Post("/payouts/:id/mark-paid",
		crmmw.RequirePermission("payouts.mark_paid"), h.MarkPaid)
	g.Post("/payouts/:id/mark-failed",
		crmmw.RequirePermission("payouts.mark_failed"), h.MarkFailed)
	g.Post("/payouts/:id/recompute",
		crmmw.RequirePermission("payouts.recompute"), h.Recompute)
}

// WorkerSummary — GET /workers/:id/payroll-payouts.
func (h *Handler) WorkerSummary(c *fiber.Ctx) error {
	workerID := c.Params("id")
	if workerID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing worker id"})
	}
	res, err := h.repo.WorkerSummary(c.UserContext(), workerID, payengine.IST())
	if err != nil {
		log.Error().Err(err).Str("worker_id", workerID).Msg("[crm.payroll] worker summary failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(res)
}

type markPaidReq struct {
	PaidAt *time.Time `json:"paid_at"`
	Notes  string     `json:"notes"`
}

// MarkPaid — POST /payroll/payouts/:id/mark-paid.
func (h *Handler) MarkPaid(c *fiber.Ctx) error {
	id := c.Params("id")
	var body markPaidReq
	if err := c.BodyParser(&body); err != nil {
		body = markPaidReq{}
	}
	if len(body.Notes) > 500 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "notes: max 500 chars"})
	}
	paidAt := time.Now().UTC()
	if body.PaidAt != nil {
		paidAt = *body.PaidAt
	}
	adminID, _ := c.Locals("crmAdminID").(string)

	updated, err := h.repo.MarkPaid(c.UserContext(), id, adminID, paidAt, body.Notes)
	if err != nil {
		return mapErr(c, err, "mark-paid")
	}
	h.recordAudit(c, "payroll_payout.mark_paid", id, nil, updated)
	return c.JSON(updated)
}

type markFailedReq struct {
	Reason string `json:"reason"`
}

// MarkFailed — POST /payroll/payouts/:id/mark-failed.
func (h *Handler) MarkFailed(c *fiber.Ctx) error {
	id := c.Params("id")
	var body markFailedReq
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason: required"})
	}
	if len(body.Reason) > 500 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "reason: max 500 chars"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)

	updated, err := h.repo.MarkFailed(c.UserContext(), id, adminID, body.Reason)
	if err != nil {
		return mapErr(c, err, "mark-failed")
	}
	h.recordAudit(c, "payroll_payout.mark_failed", id, nil, updated)
	return c.JSON(updated)
}

// Recompute — POST /payroll/payouts/:id/recompute.
func (h *Handler) Recompute(c *fiber.Ctx) error {
	id := c.Params("id")

	cycle, proID, err := h.repo.CycleBounds(c.UserContext(), id)
	if err != nil {
		return mapErr(c, err, "recompute")
	}

	pay, err := h.engine.ComputeForHelper(c.UserContext(), proID, cycle)
	if err != nil {
		log.Error().Err(err).Str("payout_id", id).Msg("[crm.payroll] recompute aggregate failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "recompute failed: " + err.Error()})
	}

	adminID, _ := c.Locals("crmAdminID").(string)
	updated, err := h.repo.RecomputeApply(c.UserContext(), id, adminID, pay)
	if err != nil {
		return mapErr(c, err, "recompute")
	}
	h.recordAudit(c, "payroll_payout.recompute", id, nil, updated)
	return c.JSON(updated)
}

// ─── helpers ──────────────────────────────────────────────────────

func (h *Handler) recordAudit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "payroll",
		TargetType: "payroll_payout", TargetID: target,
		Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}

func mapErr(c *fiber.Ctx, err error, op string) error {
	switch {
	case errors.Is(err, ErrPayoutNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "payout not found"})
	case errors.Is(err, ErrPaidRowImmutable):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "paid rows are immutable; mark-failed first"})
	case errors.Is(err, ErrInvalidTransition):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, ErrMissingRequired):
		// admin_id ended up empty — JWT middleware should have set it.
		// Surface as 401 so the caller re-authenticates rather than 500.
		log.Error().Err(err).Str("op", op).Msg("[crm.payroll] missing admin id; middleware bug")
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "admin identity not established"})
	}
	log.Error().Err(err).Str("op", op).Msg("[crm.payroll] handler error")
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
}
