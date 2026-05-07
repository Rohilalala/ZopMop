package admin

import (
	"encoding/json"
	"time"
)

// Permission constants for granular admin access control.
const (
	PermManageServices   = "manage_services"   // Create/edit/delete service categories.
	PermManageContent    = "manage_content"     // Edit banners, hero text, promotional text.
	PermManageConfig     = "manage_config"      // Edit app-wide config (surge pricing, radius, fees).
	PermManagePromotions = "manage_promotions"  // Create/edit/disable promotions and coupons.
	PermManageUsers      = "manage_users"       // View, suspend, unsuspend users and helpers.
	PermViewAnalytics    = "view_analytics"     // Read-only access to dashboard metrics.
)

// AdminUser represents an admin user with their permissions.
type AdminUser struct {
	ID          string          `json:"id"`
	UserID      string          `json:"user_id"`
	Permissions json.RawMessage `json:"permissions"` // JSONB array of permission strings.
	CreatedAt   time.Time       `json:"created_at"`
}

// AdminActionLog records audit trail entries for admin actions.
type AdminActionLog struct {
	ID         string          `json:"id"`
	AdminID    string          `json:"admin_id"`
	Action     string          `json:"action"`
	TargetType string          `json:"target_type"` // e.g. "user", "banner", "config"
	TargetID   string          `json:"target_id"`
	OldValue   json.RawMessage `json:"old_value,omitempty"`
	NewValue   json.RawMessage `json:"new_value,omitempty"`
	IPAddress  string          `json:"ip_address"`
	CreatedAt  time.Time       `json:"created_at"`
}

// DashboardStats holds overview metrics for the admin dashboard.
type DashboardStats struct {
	TotalUsers     int   `json:"total_users"`
	TotalHelpers   int   `json:"total_helpers"`
	ActiveBookings int   `json:"active_bookings"`
	RevenueTodayCents int `json:"revenue_today_cents"`
}

// UserListItem represents a user in the admin user list.
type UserListItem struct {
	ID          string    `json:"id"`
	Phone       string    `json:"phone"`
	Name        string    `json:"name"`
	Role        string    `json:"role"`
	IsSuspended bool      `json:"is_suspended"`
	CreatedAt   time.Time `json:"created_at"`
}

// HelperListItem represents a helper in the admin helper list.
type HelperListItem struct {
	ID          string  `json:"id"`
	Phone       string  `json:"phone"`
	Name        string  `json:"name"`
	IsAvailable bool    `json:"is_available"`
	Rating      float64 `json:"rating"`
	TotalJobs   int     `json:"total_jobs"`
	CurrentLat  float64 `json:"current_lat,omitempty"`
	CurrentLng  float64 `json:"current_lng,omitempty"`
}

// BookingListItem represents a booking in the admin booking list.
type BookingListItem struct {
	ID                string    `json:"id"`
	CustomerID        string    `json:"customer_id"`
	CustomerPhone     string    `json:"customer_phone"`
	HelperID          *string   `json:"helper_id,omitempty"`
	HelperPhone       *string   `json:"helper_phone,omitempty"`
	ServiceCategory   string    `json:"service_category"`
	Status        string    `json:"status"`
	AmountPaise   int       `json:"price_cents"`
	DiscountPaise int       `json:"discount_cents"`
	CreatedAt     time.Time `json:"created_at"`
}

// PaginatedResponse is a generic paginated response wrapper.
type PaginatedResponse struct {
	Data       interface{} `json:"data"`
	Page       int         `json:"page"`
	Limit      int         `json:"limit"`
	TotalCount int         `json:"total_count"`
	TotalPages int         `json:"total_pages"`
}

// Promotion represents a promotional coupon code.
type Promotion struct {
	ID            string    `json:"id"`
	Code          string    `json:"code"`
	DiscountType  string    `json:"discount_type"` // "percent" or "fixed"
	DiscountValue int       `json:"discount_value"`
	MinOrderCents int       `json:"min_order_cents"`
	MaxUses       int       `json:"max_uses"` // 0 = unlimited
	UsesCount     int       `json:"uses_count"`
	IsActive      bool      `json:"is_active"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	CreatedBy     string    `json:"created_by"`
	CreatedAt     time.Time `json:"created_at"`
}

// UpdateUserStatusRequest is the payload for updating a customer's status.
type UpdateUserStatusRequest struct {
	IsSuspended bool `json:"is_suspended"`
}

// PromotionRequest is the admin-facing DTO for creating or updating a
// promotion. Server-owned fields (ID, UsesCount, CreatedBy, CreatedAt) are
// intentionally NOT present here to prevent mass-assignment via request body.
type PromotionRequest struct {
	Code          string     `json:"code"            validate:"required,min=3,max=32,alphanum"`
	DiscountType  string     `json:"discount_type"   validate:"required,oneof=percent fixed"`
	DiscountValue int        `json:"discount_value"  validate:"required,min=1,max=100000"`
	MinOrderCents int        `json:"min_order_cents" validate:"min=0,max=10000000"`
	MaxUses       int        `json:"max_uses"        validate:"min=0,max=1000000"`
	IsActive      bool       `json:"is_active"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
}

// ToPromotion converts the request DTO into the persisted Promotion model,
// leaving server-owned fields (ID, UsesCount, CreatedBy, CreatedAt) zero so
// they are set exclusively by the service/repository layer.
func (r PromotionRequest) ToPromotion() Promotion {
	return Promotion{
		Code:          r.Code,
		DiscountType:  r.DiscountType,
		DiscountValue: r.DiscountValue,
		MinOrderCents: r.MinOrderCents,
		MaxUses:       r.MaxUses,
		IsActive:      r.IsActive,
		ExpiresAt:     r.ExpiresAt,
	}
}

// BroadcastNotificationRequest is the payload for manual push notification broadcast.
// Target controls who receives it:
//   - "customers" — all users with role=customer (default if omitted)
//   - "pros"      — all users with role=pro
//   - "all"       — every registered user
type BroadcastNotificationRequest struct {
	Title  string `json:"title"  validate:"required,min=2"`
	Body   string `json:"body"   validate:"required,min=2"`
	Target string `json:"target" validate:"omitempty,oneof=customers pros all"`
}
