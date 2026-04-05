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
	Status            string    `json:"status"`
	PriceCents        int       `json:"price_cents"`
	DiscountCents     int       `json:"discount_cents"`
	CreatedAt         time.Time `json:"created_at"`
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

// BroadcastNotificationRequest is the payload for manual push notification broadcast
type BroadcastNotificationRequest struct {
	Title string `json:"title" validate:"required,min=2"`
	Body  string `json:"body" validate:"required,min=2"`
}
