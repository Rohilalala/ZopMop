package shift

import (
	"errors"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler exposes the shift system over HTTP. Two route groups:
//
//   - /api/v1/pro/*    — protected by AuthMiddleware + AuthPro,
//                        scoped to a single pro via the JWT.
//   - /api/v1/admin/*  — protected by the existing admin middleware,
//                        zone-approval review endpoints.
type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterProRoutes mounts the pro-side surface. Caller should chain
// AuthMiddleware + AuthPro before calling this.
func (h *Handler) RegisterProRoutes(r fiber.Router) {
	r.Get("/commitments", h.ListCommitments)
	r.Post("/commitments", h.CreateCommitment)
	r.Delete("/commitments/:id", h.DeleteCommitment)

	r.Post("/shifts/:commitment_id/go-online", h.GoOnline)
	r.Post("/shifts/:commitment_id/go-offline", h.GoOffline)
	r.Post("/shifts/:commitment_id/zone-approval-request", h.RequestZoneApproval)

	r.Get("/shifts/active", h.ActiveShift)
	r.Get("/fortnight/progress", h.FortnightProgress)
	r.Get("/zone", h.CurrentZone)

	r.Post("/bookings/:id/cancel", h.CancelBooking)
}

// RegisterAdminRoutes mounts the CRM zone-approval admin path.
func (h *Handler) RegisterAdminRoutes(r fiber.Router) {
	r.Get("/zone-approval-requests", h.ListZoneApprovalRequests)
	r.Post("/zone-approval-requests/:id/approve", h.ApproveZoneRequest)
	r.Post("/zone-approval-requests/:id/reject", h.RejectZoneRequest)
}

// ─── Pro handlers ─────────────────────────────────────────────────

func (h *Handler) ListCommitments(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	rows, err := h.svc.ListUpcomingCommitments(c.UserContext(), proID)
	if err != nil {
		return internalErr(c, "list commitments", err)
	}
	return c.JSON(fiber.Map{"commitments": rows})
}

func (h *Handler) CreateCommitment(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	var req CommitRequest
	if err := c.BodyParser(&req); err != nil {
		return badRequest(c, "invalid request body")
	}
	if err := validator.Validate.Struct(req); err != nil {
		return validationErr(c, err)
	}
	row, err := h.svc.CommitShift(c.UserContext(), proID, req)
	if err != nil {
		return mapShiftErr(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(row)
}

func (h *Handler) DeleteCommitment(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	id := c.Params("id")
	if err := h.svc.UncommitShift(c.UserContext(), proID, id); err != nil {
		return mapShiftErr(c, err)
	}
	return c.JSON(fiber.Map{"message": "cancelled"})
}

func (h *Handler) GoOnline(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	commitmentID := c.Params("commitment_id")
	var req GoOnlineRequest
	if err := c.BodyParser(&req); err != nil {
		return badRequest(c, "invalid request body")
	}
	if err := validator.Validate.Struct(req); err != nil {
		return validationErr(c, err)
	}
	res, err := h.svc.GoOnline(c.UserContext(), proID, commitmentID, req.Lat, req.Lng)
	if err != nil {
		return mapShiftErr(c, err)
	}
	return c.JSON(res)
}

func (h *Handler) GoOffline(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	sess, _, err := h.svc.repo.CurrentSessionForPro(c.UserContext(), proID)
	if err != nil {
		return internalErr(c, "load session", err)
	}
	if sess == nil {
		return mapShiftErr(c, ErrNotOnline)
	}
	if err := h.svc.GoOffline(c.UserContext(), proID, sess.ID); err != nil {
		return mapShiftErr(c, err)
	}
	return c.JSON(fiber.Map{"message": "offline", "session_id": sess.ID})
}

func (h *Handler) RequestZoneApproval(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	commitmentID := c.Params("commitment_id")
	var req ZoneApprovalRequestBody
	if err := c.BodyParser(&req); err != nil {
		return badRequest(c, "invalid request body")
	}
	if err := validator.Validate.Struct(req); err != nil {
		return validationErr(c, err)
	}
	id, err := h.svc.RequestManualApproval(c.UserContext(), proID, commitmentID, req.Lat, req.Lng, req.PhotoURL)
	if err != nil {
		return mapShiftErr(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"request_id": id, "status": "pending"})
}

func (h *Handler) ActiveShift(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	sess, commitmentID, err := h.svc.repo.CurrentSessionForPro(c.UserContext(), proID)
	if err != nil {
		return internalErr(c, "load session", err)
	}
	if sess == nil {
		return c.JSON(fiber.Map{"session": nil, "commitment": nil})
	}
	commit, err := h.svc.repo.GetCommitment(c.UserContext(), commitmentID)
	if err != nil {
		return internalErr(c, "load commitment", err)
	}
	return c.JSON(fiber.Map{"session": sess, "commitment": commit})
}

func (h *Handler) CurrentZone(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	z, err := h.svc.repo.CurrentZoneInfo(c.UserContext(), proID)
	if err != nil {
		return internalErr(c, "current zone", err)
	}
	return c.JSON(fiber.Map{"zone": z})
}

func (h *Handler) FortnightProgress(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	prog, err := h.svc.FortnightProgress(c.UserContext(), proID)
	if err != nil {
		return internalErr(c, "fortnight progress", err)
	}
	return c.JSON(prog)
}

func (h *Handler) CancelBooking(c *fiber.Ctx) error {
	proID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	bookingID := c.Params("id")
	res, err := h.svc.CancelBooking(c.UserContext(), proID, bookingID)
	if err != nil {
		return mapShiftErr(c, err)
	}
	return c.JSON(res)
}

// ─── Admin handlers ───────────────────────────────────────────────

func (h *Handler) ListZoneApprovalRequests(c *fiber.Ctx) error {
	rows, err := h.svc.repo.ListPendingZoneApprovals(c.UserContext())
	if err != nil {
		return internalErr(c, "list zone approvals", err)
	}
	return c.JSON(fiber.Map{"requests": rows})
}

func (h *Handler) ApproveZoneRequest(c *fiber.Ctx) error {
	adminID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	id := c.Params("id")
	if err := h.svc.ApproveZoneRequest(c.UserContext(), id, adminID); err != nil {
		return internalErr(c, "approve zone request", err)
	}
	return c.JSON(fiber.Map{"message": "approved"})
}

func (h *Handler) RejectZoneRequest(c *fiber.Ctx) error {
	adminID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
	id := c.Params("id")
	var body struct {
		Notes string `json:"notes" validate:"omitempty,max=500"`
	}
	_ = c.BodyParser(&body)
	if err := h.svc.RejectZoneRequest(c.UserContext(), id, adminID, body.Notes); err != nil {
		return internalErr(c, "reject zone request", err)
	}
	return c.JSON(fiber.Map{"message": "rejected"})
}

// ─── Error mappers ────────────────────────────────────────────────

func badRequest(c *fiber.Ctx, msg string) error {
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": msg})
}

func validationErr(c *fiber.Ctx, err error) error {
	return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
		"error":  "validation failed",
		"fields": validator.FormatValidationErrors(err),
	})
}

func internalErr(c *fiber.Ctx, what string, err error) error {
	log.Error().Err(err).Str("op", what).Msg("[shift] internal error")
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
}

func mapShiftErr(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, ErrCommitmentNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, ErrCommitmentLocked),
		errors.Is(err, ErrShiftAfterLockWindow),
		errors.Is(err, ErrShiftDateInPast),
		errors.Is(err, ErrShiftBounds),
		errors.Is(err, ErrShiftOverlap):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, ErrShiftNotActive),
		errors.Is(err, ErrAlreadyOnline),
		errors.Is(err, ErrNotOnline),
		errors.Is(err, ErrBookingsPending),
		errors.Is(err, ErrApprovalPending),
		errors.Is(err, ErrOutsideZone):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, ErrNoZoneAssigned):
		return c.Status(fiber.StatusPreconditionFailed).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, ErrBookingNotOwnedByPro):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": err.Error()})
	default:
		return internalErr(c, "shift op", err)
	}
}
