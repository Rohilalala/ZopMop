package roomies

import (
	"errors"

	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the Roomies module.
type Handler struct {
	service *Service
}

// NewHandler creates a new roomies handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts all roomies routes onto the given authenticated router group.
// Caller is responsible for attaching auth middleware before passing the group.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/groups", h.CreateGroup)
	router.Post("/groups/join", h.JoinGroup)
	router.Get("/groups/me", h.GetMyGroup)
	router.Delete("/groups/:id/members/:userID", h.LeaveGroup)
	router.Post("/groups/:id/transfer-host", h.TransferHost)
	router.Delete("/groups/:id", h.DeleteGroup)
	router.Post("/groups/:id/book", h.BookGroupChore)
	router.Post("/members/:memberID/topup", h.TopUpPrepaid)
	router.Post("/debts/:debtID/settle-external", h.MarkSettlementExternal)
	router.Post("/debts/:debtID/verify", h.VerifySettlement)
	router.Get("/groups/:id/ledger", h.GetLedger)
	router.Get("/groups/:id/vault", h.GetVault)
}

// mapServiceError converts sentinel errors to appropriate HTTP status codes.
func mapServiceError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, ErrHostMustTransferFirst),
		errors.Is(err, ErrMemberAlreadyExists),
		errors.Is(err, ErrIdempotencyKeyConflict),
		errors.Is(err, ErrGroupHasActiveFinancials),
		errors.Is(err, ErrGroupFull),
		errors.Is(err, ErrAlreadyInGroup),
		errors.Is(err, ErrAddressAlreadyHasGroup):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, ErrNotGroupHost), errors.Is(err, ErrUnauthorized):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, ErrNotGroupMember), errors.Is(err, ErrDebtNotFound), errors.Is(err, ErrInvalidCode):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, ErrBelowMinimumTopUp):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	default:
		log.Error().Err(err).Msg("roomies: unhandled service error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal server error"})
	}
}

// POST /groups
func (h *Handler) CreateGroup(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)

	var req CreateGroupRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	group, err := h.service.CreateGroup(c.Context(), userID, req.AddressID, req.Name)
	if err != nil {
		return mapServiceError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(group)
}

// POST /groups/join
func (h *Handler) JoinGroup(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)

	var req JoinGroupRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	resp, err := h.service.JoinGroup(c.Context(), req.Code, userID)
	if err != nil {
		return mapServiceError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(resp)
}

// GET /groups/me
func (h *Handler) GetMyGroup(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)

	resp, err := h.service.GetMyGroup(c.Context(), userID)
	if err != nil {
		return mapServiceError(c, err)
	}
	if resp == nil {
		return c.JSON(fiber.Map{"group": nil})
	}
	return c.JSON(resp)
}

// DELETE /groups/:id/members/:userID
// Query param: ?force=true to proceed despite pending dues warning.
func (h *Handler) LeaveGroup(c *fiber.Ctx) error {
	callerID, _ := c.Locals("userID").(string)
	groupID := c.Params("id")
	targetUserID := c.Params("userID")
	if !validator.IsUUID(groupID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group id"})
	}
	if !validator.IsUUID(targetUserID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user id"})
	}
	force := c.Query("force") == "true"

	// Only allow users to remove themselves (or host removes a member — future scope).
	if callerID != targetUserID {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "cannot remove another member"})
	}

	result, err := h.service.LeaveGroup(c.Context(), groupID, callerID, force)
	if err != nil {
		return mapServiceError(c, err)
	}
	return c.JSON(result)
}

// POST /groups/:id/transfer-host
func (h *Handler) TransferHost(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	groupID := c.Params("id")
	if !validator.IsUUID(groupID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group id"})
	}

	var req TransferHostRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	if err := h.service.TransferHost(c.Context(), groupID, userID, req.ToUserID); err != nil {
		return mapServiceError(c, err)
	}
	return c.JSON(fiber.Map{"message": "host transferred"})
}

// DELETE /groups/:id
// Query param: ?force=true to confirm deletion despite pending dues.
func (h *Handler) DeleteGroup(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	groupID := c.Params("id")
	if !validator.IsUUID(groupID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group id"})
	}
	force := c.Query("force") == "true"

	result, err := h.service.DeleteGroup(c.Context(), groupID, userID, force)
	if err != nil {
		return mapServiceError(c, err)
	}
	return c.JSON(result)
}

// POST /groups/:id/book
func (h *Handler) BookGroupChore(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	groupID := c.Params("id")
	if !validator.IsUUID(groupID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group id"})
	}

	var req BookGroupChoreRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	resp, err := h.service.BookGroupChore(c.Context(), groupID, req, userID)
	if err != nil {
		return mapServiceError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(resp)
}

// POST /members/:memberID/topup
func (h *Handler) TopUpPrepaid(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	memberID := c.Params("memberID")
	if !validator.IsUUID(memberID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid member id"})
	}

	// memberID here is the address_member.id — we need groupID too.
	// Accept groupID in body alongside amount.
	var body struct {
		GroupID string `json:"group_id" validate:"required,uuid_format"`
		Amount  int    `json:"amount"   validate:"required,min=25000"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if err := validator.Validate.Struct(body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	// memberID param is informational; actual top-up is keyed by (userID, groupID).
	_ = memberID
	if err := h.service.TopUpPrepaid(c.Context(), userID, body.GroupID, body.Amount); err != nil {
		return mapServiceError(c, err)
	}
	return c.JSON(fiber.Map{"message": "top-up successful"})
}

// POST /debts/:debtID/settle-external
func (h *Handler) MarkSettlementExternal(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	debtID := c.Params("debtID")
	if !validator.IsUUID(debtID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid debt id"})
	}

	if err := h.service.MarkSettlementExternal(c.Context(), debtID, userID); err != nil {
		return mapServiceError(c, err)
	}
	return c.JSON(fiber.Map{"message": "debt marked as pending verification"})
}

// POST /debts/:debtID/verify
func (h *Handler) VerifySettlement(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	debtID := c.Params("debtID")
	if !validator.IsUUID(debtID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid debt id"})
	}

	if err := h.service.VerifySettlement(c.Context(), debtID, userID); err != nil {
		return mapServiceError(c, err)
	}
	return c.JSON(fiber.Map{"message": "debt settled"})
}

// GET /groups/:id/ledger
func (h *Handler) GetLedger(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	groupID := c.Params("id")
	if !validator.IsUUID(groupID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group id"})
	}

	// SECURITY: only group members may read the ledger.
	isMember, err := h.service.IsMember(c.Context(), userID, groupID)
	if err != nil {
		return mapServiceError(c, err)
	}
	if !isMember {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not a group member"})
	}

	simplified, err := h.service.NetDebts(c.Context(), groupID)
	if err != nil {
		return mapServiceError(c, err)
	}
	return c.JSON(fiber.Map{"ledger": simplified})
}

// GET /groups/:id/vault
func (h *Handler) GetVault(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)
	groupID := c.Params("id")
	if !validator.IsUUID(groupID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group id"})
	}

	// SECURITY: only group members may read the vault summary.
	isMember, err := h.service.IsMember(c.Context(), userID, groupID)
	if err != nil {
		return mapServiceError(c, err)
	}
	if !isMember {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not a group member"})
	}

	vault, err := h.service.GetVaultSummary(c.Context(), groupID)
	if err != nil {
		return mapServiceError(c, err)
	}
	return c.JSON(vault)
}
