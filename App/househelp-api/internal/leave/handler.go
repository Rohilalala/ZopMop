package leave

import (
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"
)

// Handler exposes pro-side leave endpoints. Auth middleware must wrap the
// route group so c.Locals("userID") is populated. role=helper guard is the
// caller's responsibility — wire via mw.RoleGuard("helper") at mount time.
type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts pro-side endpoints. Group must already be JWT-guarded.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/declare", h.Declare)
	router.Get("/balance", h.Balance)
	router.Get("/history", h.History)
	router.Get("/affected-tomorrow", h.AffectedTomorrow)
}

// ── Endpoints ──────────────────────────────────────────────────────────────

type declareReq struct {
	Date string `json:"date"`
}

func (h *Handler) Declare(c *fiber.Ctx) error {
	proID, _ := c.Locals("userID").(string)
	if proID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}
	var body declareReq
	if err := c.BodyParser(&body); err != nil || body.Date == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing date"})
	}
	date, err := ParseDate(body.Date)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	outcomes, err := h.service.DeclareTomorrow(c.UserContext(), proID, date)
	if err != nil {
		switch {
		case errors.Is(err, ErrAfterCutoff):
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "Leave can no longer be declared for tomorrow. Contact your manager.",
				"code":  "AFTER_CUTOFF",
			})
		case errors.Is(err, ErrBalanceExhausted):
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "Leave balance exhausted. Contact admin to allocate additional leave.",
				"code":  "BALANCE_EXHAUSTED",
			})
		case errors.Is(err, ErrNotTomorrow):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "Leave can only be declared for tomorrow.",
				"code":  "NOT_TOMORROW",
			})
		case errors.Is(err, ErrAlreadyDeclared):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "You've already declared leave for this date.",
				"code":  "ALREADY_DECLARED",
			})
		default:
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "could not declare leave"})
		}
	}

	bal, _ := h.service.Balance(c.UserContext(), proID)
	return c.JSON(fiber.Map{
		"date":             date.Format("2006-01-02"),
		"balance":          bal,
		"reassigned_count": countReassigned(outcomes),
		"cancelled_count":  countCancelled(outcomes),
		"outcomes":         outcomes,
	})
}

func (h *Handler) Balance(c *fiber.Ctx) error {
	proID, _ := c.Locals("userID").(string)
	if proID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}
	bal, err := h.service.Balance(c.UserContext(), proID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "could not load balance"})
	}
	return c.JSON(bal)
}

func (h *Handler) AffectedTomorrow(c *fiber.Ctx) error {
	proID, _ := c.Locals("userID").(string)
	if proID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}
	rows, err := h.service.AffectedTomorrow(c.UserContext(), proID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "could not load affected bookings"})
	}
	return c.JSON(fiber.Map{"bookings": rows})
}

func (h *Handler) History(c *fiber.Ctx) error {
	proID, _ := c.Locals("userID").(string)
	if proID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}
	limit := c.QueryInt("limit", 50)
	rows, err := h.service.History(c.UserContext(), proID, limit)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "could not load history"})
	}
	return c.JSON(fiber.Map{"leaves": rows})
}

// ── CRM admin handler ──────────────────────────────────────────────────────

// AdminHandler exposes admin-side endpoints. Mount under the CRM router with
// the existing CRM auth + role middleware.
type AdminHandler struct {
	service *Service
}

func NewAdminHandler(service *Service) *AdminHandler {
	return &AdminHandler{service: service}
}

func (h *AdminHandler) RegisterRoutes(router fiber.Router) {
	router.Post("/pro/:id/leave/allocate", h.Allocate)
	router.Get("/pro/:id/leave", h.History)
	router.Post("/pro/:id/leave/grant", h.Grant)
}

type allocateReq struct {
	Days int `json:"days"`
}

func (h *AdminHandler) Allocate(c *fiber.Ctx) error {
	proID := c.Params("id")
	if proID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing pro id"})
	}
	var body allocateReq
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	if body.Days == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "days must be non-zero"})
	}
	newBalance, err := h.service.AllocateExtra(c.UserContext(), proID, body.Days)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "could not allocate"})
	}
	return c.JSON(fiber.Map{"pro_id": proID, "balance": newBalance, "delta": body.Days})
}

func (h *AdminHandler) History(c *fiber.Ctx) error {
	proID := c.Params("id")
	if proID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing pro id"})
	}
	limit := c.QueryInt("limit", 200)
	rows, err := h.service.History(c.UserContext(), proID, limit)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "could not load history"})
	}
	bal, _ := h.service.Balance(c.UserContext(), proID)
	return c.JSON(fiber.Map{"pro_id": proID, "balance": bal, "leaves": rows})
}

// Grant lets admin add a leave row for a specific date without spending the
// pro's balance. Useful for medical / approved-outside-quota leaves.
type grantReq struct {
	Date string `json:"date"`
	Note string `json:"note"`
}

func (h *AdminHandler) Grant(c *fiber.Ctx) error {
	proID := c.Params("id")
	if proID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing pro id"})
	}
	var body grantReq
	if err := c.BodyParser(&body); err != nil || body.Date == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing date"})
	}
	date, err := ParseDate(body.Date)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	outcomes, err := h.service.AdminGrantLeave(c.UserContext(), proID, date, body.Note)
	if err != nil {
		if errors.Is(err, ErrAlreadyDeclared) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "leave already exists for that date"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "could not grant leave"})
	}
	return c.JSON(fiber.Map{
		"pro_id":           proID,
		"date":             date.Format("2006-01-02"),
		"reassigned_count": countReassigned(outcomes),
		"cancelled_count":  countCancelled(outcomes),
		"outcomes":         outcomes,
	})
}

// ── helpers ────────────────────────────────────────────────────────────────

func countReassigned(out []ReassignOutcome) int {
	n := 0
	for _, o := range out {
		if o.NewProID != "" {
			n++
		}
	}
	return n
}

func countCancelled(out []ReassignOutcome) int {
	n := 0
	for _, o := range out {
		if o.Cancelled {
			n++
		}
	}
	return n
}

// silence unused-import warning when handler doesn't directly reference time
// — kept here for the doc parser only.
var _ = time.Hour
