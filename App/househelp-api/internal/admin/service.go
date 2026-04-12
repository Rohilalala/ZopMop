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

// GetBookingsList returns a paginated list of bookings with optional status filter.
func (s *Service) GetBookingsList(ctx context.Context, page, limit int, status string) (*PaginatedResponse, error) {
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	bookings, totalCount, err := s.repo.GetBookingsList(ctx, page, limit, status)
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

// CancelBooking force-cancels a booking (admin override, bypasses state machine).
func (s *Service) CancelBooking(ctx context.Context, bookingID string) error {
	return s.repo.CancelBooking(ctx, bookingID)
}
