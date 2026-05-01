package admin

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/rs/zerolog/log"
)

// Service handles admin business logic.
type Service struct {
	repo    *Repository
	notifSvc *notification.Service
}

// NewService creates a new admin service.
func NewService(repo *Repository, notifSvc *notification.Service) *Service {
	return &Service{repo: repo, notifSvc: notifSvc}
}

// CheckPermission verifies if an admin has the required permission.
func (s *Service) CheckPermission(ctx context.Context, adminID, requiredPermission string) (bool, error) {
	permissions, err := s.repo.GetAdminPermissions(ctx, adminID)
	if err != nil {
		return false, fmt.Errorf("failed to check permission: %w", err)
	}

	for _, p := range permissions {
		if p == requiredPermission {
			return true, nil
		}
	}

	return false, nil
}

// GetDashboardStats returns aggregate metrics for the admin dashboard.
func (s *Service) GetDashboardStats(ctx context.Context) (*DashboardStats, error) {
	stats, err := s.repo.GetDashboardStats(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get dashboard stats: %w", err)
	}
	return stats, nil
}

// GetAllUsers returns a paginated list of users with optional role/search filters.
func (s *Service) GetAllUsers(ctx context.Context, page, limit int, role, search string) (*PaginatedResponse, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	users, totalCount, err := s.repo.GetAllUsers(ctx, page, limit, role, search)
	if err != nil {
		return nil, fmt.Errorf("failed to get users: %w", err)
	}

	totalPages := (totalCount + limit - 1) / limit

	return &PaginatedResponse{
		Data:       users,
		Page:       page,
		Limit:      limit,
		TotalCount: totalCount,
		TotalPages: totalPages,
	}, nil
}

// SuspendUser suspends a user and logs the admin action.
func (s *Service) SuspendUser(ctx context.Context, adminID, targetUserID, ipAddress string) error {
	if err := s.repo.SuspendUser(ctx, targetUserID); err != nil {
		return fmt.Errorf("failed to suspend user: %w", err)
	}

	// Log admin action.
	newVal, err := json.Marshal(map[string]bool{"is_suspended": true})
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal suspend user action for logging")
		newVal = []byte(`{"is_suspended":true}`)
	}
	if err := s.repo.LogAdminAction(ctx, adminID, "suspend_user", "user", targetUserID, nil, newVal, ipAddress); err != nil {
		log.Error().Err(err).Msg("failed to log suspend user action")
	}

	return nil
}

// UnsuspendUser lifts suspension on a user and logs the admin action.
func (s *Service) UnsuspendUser(ctx context.Context, adminID, targetUserID, ipAddress string) error {
	if err := s.repo.UnsuspendUser(ctx, targetUserID); err != nil {
		return fmt.Errorf("failed to unsuspend user: %w", err)
	}

	// Log admin action.
	newVal, err := json.Marshal(map[string]bool{"is_suspended": false})
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal unsuspend user action for logging")
		newVal = []byte(`{"is_suspended":false}`)
	}
	if err := s.repo.LogAdminAction(ctx, adminID, "unsuspend_user", "user", targetUserID, nil, newVal, ipAddress); err != nil {
		log.Error().Err(err).Msg("failed to log unsuspend user action")
	}

	return nil
}

// GetAllHelpers returns a paginated list of helpers with optional filters.
func (s *Service) GetAllHelpers(ctx context.Context, page, limit int, available *bool, minRating float64) (*PaginatedResponse, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	helpers, totalCount, err := s.repo.GetAllHelpers(ctx, page, limit, available, minRating)
	if err != nil {
		return nil, fmt.Errorf("failed to get helpers: %w", err)
	}

	totalPages := (totalCount + limit - 1) / limit

	return &PaginatedResponse{
		Data:       helpers,
		Page:       page,
		Limit:      limit,
		TotalCount: totalCount,
		TotalPages: totalPages,
	}, nil
}

// GetBookingsList returns a paginated list of bookings with optional status +
// search filters.
func (s *Service) GetBookingsList(ctx context.Context, page, limit int, status, search string) (*PaginatedResponse, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	bookings, totalCount, err := s.repo.GetBookingsList(ctx, page, limit, status, search)
	if err != nil {
		return nil, fmt.Errorf("failed to get bookings: %w", err)
	}

	totalPages := (totalCount + limit - 1) / limit

	return &PaginatedResponse{
		Data:       bookings,
		Page:       page,
		Limit:      limit,
		TotalCount: totalCount,
		TotalPages: totalPages,
	}, nil
}

// GetAuditLog returns a paginated audit trail with optional target type filter.
func (s *Service) GetAuditLog(ctx context.Context, page, limit int, targetType string) (*PaginatedResponse, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	logs, totalCount, err := s.repo.GetAuditLog(ctx, page, limit, targetType)
	if err != nil {
		return nil, fmt.Errorf("failed to get audit log: %w", err)
	}

	totalPages := (totalCount + limit - 1) / limit

	return &PaginatedResponse{
		Data:       logs,
		Page:       page,
		Limit:      limit,
		TotalCount: totalCount,
		TotalPages: totalPages,
	}, nil
}

// GetAllPromotions returns a paginated list of promotions.
func (s *Service) GetAllPromotions(ctx context.Context, page, limit int) (*PaginatedResponse, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	promos, totalCount, err := s.repo.GetAllPromotions(ctx, page, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to get promotions: %w", err)
	}

	totalPages := (totalCount + limit - 1) / limit

	return &PaginatedResponse{
		Data:       promos,
		Page:       page,
		Limit:      limit,
		TotalCount: totalCount,
		TotalPages: totalPages,
	}, nil
}

// CreatePromotion creates a new promotion and logs the admin action.
func (s *Service) CreatePromotion(ctx context.Context, promo *Promotion, adminID, ipAddress string) error {
	promo.CreatedBy = adminID
	if err := s.repo.CreatePromotion(ctx, promo); err != nil {
		return fmt.Errorf("failed to create promotion: %w", err)
	}

	newVal, _ := json.Marshal(promo)
	if err := s.repo.LogAdminAction(ctx, adminID, "create_promotion", "promotion", promo.ID, nil, newVal, ipAddress); err != nil {
		log.Error().Err(err).Msg("failed to log create promotion action")
	}

	return nil
}

// UpdatePromotion updates a promotion's fields and logs the admin action.
func (s *Service) UpdatePromotion(ctx context.Context, promo *Promotion, adminID, ipAddress string) error {
	if err := s.repo.UpdatePromotion(ctx, promo); err != nil {
		return fmt.Errorf("failed to update promotion: %w", err)
	}

	newVal, _ := json.Marshal(promo)
	if err := s.repo.LogAdminAction(ctx, adminID, "update_promotion", "promotion", promo.ID, nil, newVal, ipAddress); err != nil {
		log.Error().Err(err).Msg("failed to log update promotion action")
	}

	return nil
}

// DisablePromotion deactivates a promotion and logs the admin action.
func (s *Service) DisablePromotion(ctx context.Context, promoID, adminID, ipAddress string) error {
	if err := s.repo.DisablePromotion(ctx, promoID); err != nil {
		return fmt.Errorf("failed to disable promotion: %w", err)
	}

	newVal, _ := json.Marshal(map[string]bool{"is_active": false})
	if err := s.repo.LogAdminAction(ctx, adminID, "disable_promotion", "promotion", promoID, nil, newVal, ipAddress); err != nil {
		log.Error().Err(err).Msg("failed to log disable promotion action")
	}

	return nil
}

// Broadcast sends a manual push notification to the requested audience.
// target must be "customers", "pros", or "all" (default: "customers").
func (s *Service) Broadcast(ctx context.Context, title, body, target string) error {
	var tokens []string
	var err error

	switch target {
	case "pros":
		tokens, err = s.repo.GetProFCMTokens(ctx)
		if err != nil {
			return fmt.Errorf("failed to fetch pro tokens: %w", err)
		}
	case "all":
		tokens, err = s.repo.GetAllFCMTokens(ctx)
		if err != nil {
			return fmt.Errorf("failed to fetch all tokens: %w", err)
		}
	default: // "customers" or empty
		tokens, err = s.repo.GetCustomerFCMTokens(ctx)
		if err != nil {
			return fmt.Errorf("failed to fetch customer tokens: %w", err)
		}
	}

	if len(tokens) == 0 {
		log.Info().Str("target", target).Msg("[admin] broadcast: no tokens found for target audience")
		return nil
	}

	log.Info().Str("target", target).Int("recipients", len(tokens)).Str("title", title).Msg("[admin] broadcasting notification")
	return s.notifSvc.SendToTokens(ctx, tokens, title, body, map[string]string{
		"type":   "broadcast",
		"target": target,
	})
}

// ListPendingHelpers returns a paginated list of helpers awaiting approval.
func (s *Service) ListPendingHelpers(ctx context.Context, page, limit int) (*PaginatedResponse, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	helpers, totalCount, err := s.repo.GetPendingHelpers(ctx, page, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to get pending helpers: %w", err)
	}

	totalPages := (totalCount + limit - 1) / limit

	return &PaginatedResponse{
		Data:       helpers,
		Page:       page,
		Limit:      limit,
		TotalCount: totalCount,
		TotalPages: totalPages,
	}, nil
}

// ApproveHelper sets approval_status='approved' and writes an audit log entry.
func (s *Service) ApproveHelper(ctx context.Context, helperID, adminID, ipAddress string) error {
	return s.setHelperApproval(ctx, helperID, "approved", "approve_helper", adminID, ipAddress)
}

// RejectHelper sets approval_status='rejected' and writes an audit log entry.
func (s *Service) RejectHelper(ctx context.Context, helperID, adminID, ipAddress string) error {
	return s.setHelperApproval(ctx, helperID, "rejected", "reject_helper", adminID, ipAddress)
}

func (s *Service) setHelperApproval(ctx context.Context, helperID, status, action, adminID, ipAddress string) error {
	if err := s.repo.SetHelperApproval(ctx, helperID, status); err != nil {
		return err
	}

	newVal, err := json.Marshal(map[string]string{"approval_status": status})
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal helper approval action for logging")
		newVal = []byte(fmt.Sprintf(`{"approval_status":%q}`, status))
	}
	if err := s.repo.LogAdminAction(ctx, adminID, action, "helper", helperID, nil, newVal, ipAddress); err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to log helper approval action")
	}
	return nil
}

// ListPendingRefunds returns a paginated list of refunds (filtered by status).
func (s *Service) ListPendingRefunds(ctx context.Context, status string, page, limit int) (*PaginatedResponse, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	refunds, totalCount, err := s.repo.ListPendingRefunds(ctx, status, page, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to get pending refunds: %w", err)
	}

	totalPages := (totalCount + limit - 1) / limit

	return &PaginatedResponse{
		Data:       refunds,
		Page:       page,
		Limit:      limit,
		TotalCount: totalCount,
		TotalPages: totalPages,
	}, nil
}

// SettleRefund marks a refund as settled and audit-logs the admin action.
func (s *Service) SettleRefund(ctx context.Context, id, adminID, ipAddress string) (*PendingRefund, error) {
	pr, err := s.repo.SettlePendingRefund(ctx, id)
	if err != nil {
		return nil, err
	}

	newVal, mErr := json.Marshal(map[string]interface{}{
		"status":       pr.Status,
		"amount_cents": pr.AmountCents,
		"source":       pr.Source,
		"source_ref":   pr.SourceRef,
		"user_id":      pr.UserID,
	})
	if mErr != nil {
		log.Error().Err(mErr).Msg("failed to marshal settle refund action for logging")
		newVal = []byte(`{"status":"settled"}`)
	}
	if logErr := s.repo.LogAdminAction(ctx, adminID, "settle_refund", "refund", pr.ID, nil, newVal, ipAddress); logErr != nil {
		log.Error().Err(logErr).Str("refund_id", pr.ID).Msg("failed to log settle refund action")
	}

	return pr, nil
}

// CancelBooking force-cancels a booking (admin override, bypasses state machine)
// and writes an audit trail entry.
func (s *Service) CancelBooking(ctx context.Context, adminID, bookingID, ipAddress string) error {
	previousStatus, err := s.repo.GetBookingStatus(ctx, bookingID)
	if err != nil {
		return err
	}

	if err := s.repo.CancelBooking(ctx, bookingID); err != nil {
		return err
	}

	oldVal, _ := json.Marshal(map[string]string{
		"status": previousStatus,
	})
	newVal, _ := json.Marshal(map[string]string{
		"status":       "cancelled",
		"cancelled_by": "admin",
	})

	if err := s.repo.LogAdminAction(ctx, adminID, "cancel_booking_override", "booking", bookingID, oldVal, newVal, ipAddress); err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Msg("failed to log admin booking cancel override")
	}

	return nil
}
