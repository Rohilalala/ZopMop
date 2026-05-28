// Package cash implements the CRM owes-tracking + settle-action surface for
// the customer-choice cash payment flow introduced in Phase 1 Step 3.
//
// The model:
//
//   - The customer (NOT the pro) chooses cash at end of service via
//     POST /bookings/:id/resolve-cash. That handler stamps
//     bookings.cash_collected_by_pro = helper_id and
//     bookings.cash_collected_at = NOW(). See
//     (booking.Service).ResolveCash for the guards.
//
//   - That stamp means the pro is now physically holding company money.
//     The amount owed by the pro to the company is
//     SUM(amount_paise - discount_paise) of all their unsettled
//     cash-resolved bookings.
//
//   - When the pro hands the cash to an admin (in person, end of day),
//     the admin opens the CRM and clicks "Mark settled". That fires the
//     Settle handler in this package, which flips cash_settled_at +
//     cash_settled_by_admin on every unsettled row for that pro, in one
//     batch. The pro's owed balance becomes zero.
//
// Pro payroll (internal/payroll/calc.go) is intentionally untouched.
// Cash collection and pro pay are SEPARATE LEDGERS. They never net
// against each other. See docs/phase-1-payment-gated-flow.md.
package cash

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// ProOwesRow is one row of the CRM owes dashboard. One per pro with at
// least one unsettled cash collection.
type ProOwesRow struct {
	ProID               string    `json:"pro_id"`
	ProName             string    `json:"pro_name"`
	ProPhone            string    `json:"pro_phone"`
	UnsettledCount      int       `json:"unsettled_count"`
	OwesPaise           int64     `json:"owes_paise"`
	OldestUnsettledAt   time.Time `json:"oldest_unsettled_at"`
}

// CollectionRow is one cash collection (one booking) within a single
// pro's unsettled set. Returned by GetProOwes for the detail view.
type CollectionRow struct {
	BookingID        string    `json:"booking_id"`
	AmountPaise      int64     `json:"amount_paise"`
	CashCollectedAt  time.Time `json:"cash_collected_at"`
}

// SettleResult is the response to POST /cash/owes/:proID/settle.
type SettleResult struct {
	ProID         string `json:"pro_id"`
	SettledCount  int    `json:"settled_count"`
	SettledPaise  int64  `json:"settled_paise"`
}

// ErrProNotFound is returned by Settle when the supplied pro id has
// no unsettled cash collections. Maps to 404 — nothing to settle.
var ErrProNotFound = errors.New("crm.cash: pro has no unsettled cash")

// Repository is the data layer for the CRM cash module.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

// ListOwes returns one row per pro with at least one unsettled cash
// collection. Ordered by oldest_unsettled_at ASC so the dashboard
// surfaces the most overdue first.
func (r *Repository) ListOwes(ctx context.Context) ([]ProOwesRow, error) {
	rows, err := r.db.Query(ctx, `
		SELECT
		  h.id::text                                          AS pro_id,
		  h.full_name                                         AS pro_name,
		  h.phone                                             AS pro_phone,
		  COUNT(b.id)                                         AS unsettled_count,
		  SUM(b.amount_paise - COALESCE(b.discount_paise, 0)) AS owes_paise,
		  MIN(b.cash_collected_at)                            AS oldest_unsettled_at
		FROM bookings b
		JOIN helpers h ON h.id = b.cash_collected_by_pro
		WHERE b.cash_settled_at IS NULL
		GROUP BY h.id, h.full_name, h.phone
		ORDER BY oldest_unsettled_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("crm.cash list owes: %w", err)
	}
	defer rows.Close()
	out := make([]ProOwesRow, 0, 32)
	for rows.Next() {
		var row ProOwesRow
		if err := rows.Scan(
			&row.ProID, &row.ProName, &row.ProPhone,
			&row.UnsettledCount, &row.OwesPaise, &row.OldestUnsettledAt,
		); err != nil {
			return nil, fmt.Errorf("crm.cash scan owes row: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// GetProOwes returns the per-collection detail for a single pro's
// unsettled cash. Used by the CRM detail drawer before settling.
func (r *Repository) GetProOwes(ctx context.Context, proID string) ([]CollectionRow, error) {
	rows, err := r.db.Query(ctx, `
		SELECT
		  b.id::text                                       AS booking_id,
		  b.amount_paise - COALESCE(b.discount_paise, 0)   AS amount_paise,
		  b.cash_collected_at                              AS cash_collected_at
		FROM bookings b
		WHERE b.cash_collected_by_pro = $1::uuid
		  AND b.cash_settled_at IS NULL
		ORDER BY b.cash_collected_at ASC
	`, proID)
	if err != nil {
		return nil, fmt.Errorf("crm.cash get pro owes: %w", err)
	}
	defer rows.Close()
	out := make([]CollectionRow, 0, 8)
	for rows.Next() {
		var row CollectionRow
		if err := rows.Scan(&row.BookingID, &row.AmountPaise, &row.CashCollectedAt); err != nil {
			return nil, fmt.Errorf("crm.cash scan collection row: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Settle batch-flips all unsettled cash collections for the supplied pro
// to settled, stamping who (adminID) and when (NOW()). Returns the count
// of rows flipped and the total paise. ErrProNotFound when the pro has
// nothing unsettled — admin clicked settle on a stale view.
func (r *Repository) Settle(ctx context.Context, proID, adminID string) (SettleResult, error) {
	rows, err := r.db.Query(ctx, `
		UPDATE bookings
		   SET cash_settled_at       = NOW(),
		       cash_settled_by_admin = $2::uuid,
		       updated_at            = NOW()
		 WHERE cash_collected_by_pro = $1::uuid
		   AND cash_settled_at IS NULL
		RETURNING amount_paise - COALESCE(discount_paise, 0)
	`, proID, adminID)
	if err != nil {
		return SettleResult{}, fmt.Errorf("crm.cash settle: %w", err)
	}
	defer rows.Close()
	res := SettleResult{ProID: proID}
	for rows.Next() {
		var paise int64
		if err := rows.Scan(&paise); err != nil {
			return SettleResult{}, fmt.Errorf("crm.cash scan settle result: %w", err)
		}
		res.SettledCount++
		res.SettledPaise += paise
	}
	if err := rows.Err(); err != nil {
		return SettleResult{}, err
	}
	if res.SettledCount == 0 {
		return SettleResult{}, ErrProNotFound
	}
	return res, nil
}

// Handler is the fiber-level HTTP surface for the CRM cash module.
type Handler struct {
	repo     *Repository
	recorder *audit.Recorder
}

// NewHandler constructs a Handler.
func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// RegisterRoutes mounts /cash/* under the supplied CRM group. The group
// must already have admin auth attached.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/cash")
	read := middleware.RequirePermission("cash.read")
	g.Get("/owes", read, h.ListOwes)
	g.Get("/owes/:proID", read, h.GetProOwes)
	g.Post("/owes/:proID/settle", middleware.RequirePermission("cash.settle"), h.Settle)
}

// ListOwes — GET /cash/owes — list every pro who currently owes cash.
func (h *Handler) ListOwes(c *fiber.Ctx) error {
	items, err := h.repo.ListOwes(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.cash] list owes failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": items, "total_count": len(items)})
}

// GetProOwes — GET /cash/owes/:proID — per-collection detail for one pro.
func (h *Handler) GetProOwes(c *fiber.Ctx) error {
	proID := c.Params("proID")
	if proID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing pro id"})
	}
	items, err := h.repo.GetProOwes(c.UserContext(), proID)
	if err != nil {
		log.Error().Err(err).Str("pro_id", proID).Msg("[crm.cash] get pro owes failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": items, "total_count": len(items)})
}

// Settle — POST /cash/owes/:proID/settle — batch settle all of one pro's
// unsettled cash collections. Writes a crm_audit_log row for the action.
func (h *Handler) Settle(c *fiber.Ctx) error {
	proID := c.Params("proID")
	if proID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing pro id"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}

	res, err := h.repo.Settle(c.UserContext(), proID, adminID)
	if err != nil {
		if errors.Is(err, ErrProNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"error": "pro has no unsettled cash", "code": "NOTHING_TO_SETTLE",
			})
		}
		log.Error().Err(err).Str("pro_id", proID).Msg("[crm.cash] settle failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	// Audit. Module=cash, action=settle, target=proID. After-value carries
	// the count + total paise so the audit log captures what was settled
	// in one row even though the underlying UPDATE touched many bookings.
	if h.recorder != nil {
		adminEmail, _ := c.Locals("crmAdminEmail").(string)
		h.recorder.Log(c.UserContext(), audit.Entry{
			AdminID:    adminID,
			AdminEmail: adminEmail,
			Action:     "cash.settle",
			Module:     "cash",
			TargetType: "pro",
			TargetID:   proID,
			After: map[string]any{
				"settled_count": res.SettledCount,
				"settled_paise": res.SettledPaise,
			},
			IPAddress: c.IP(),
			UserAgent: string(c.Request().Header.UserAgent()),
		})
	}

	return c.JSON(res)
}
