// Package users is the CRM-side surface for managing customer + pro accounts.
// All queries route through the CRM read pool by default; mutations use the
// write pool. The package never reaches into helpers / bookings business
// logic — it only reads from those tables and writes to user-level fields.
package users

import "time"

// Status is the rolled-up account state shown in the CRM. Derived from the
// user row, not stored — banned takes precedence over suspended over deleted.
type Status string

const (
	StatusActive    Status = "active"
	StatusSuspended Status = "suspended"
	StatusBanned    Status = "banned"
	StatusDeleted   Status = "deleted"
)

// ListItem is the row shown in the users table.
type ListItem struct {
	ID            string     `json:"id"`
	Phone         string     `json:"phone"`
	Email         *string    `json:"email,omitempty"`
	Name          *string    `json:"name,omitempty"`
	AvatarURL     *string    `json:"avatar_url,omitempty"`
	Role          string     `json:"role"`
	Status        Status     `json:"status"`
	IsVIP         bool       `json:"is_vip"`
	JoinedAt      time.Time  `json:"joined_at"`
	TotalOrders   int        `json:"total_orders"`
	LTVCents      int64      `json:"ltv_paise"`
	LastActiveAt  *time.Time `json:"last_active_at,omitempty"`
}

// Detail is the per-user view shown in the drawer.
type Detail struct {
	ListItem
	SuspendReason *string  `json:"suspend_reason,omitempty"`
	BanReason     *string  `json:"ban_reason,omitempty"`
	BannedAt      *time.Time `json:"banned_at,omitempty"`
	AvgOrderCents int64    `json:"avg_order_paise"`
	ActiveOrders  int      `json:"active_orders"`
	PreferredCategories []CategoryShare `json:"preferred_categories"`
}

// CategoryShare is one slice of the per-user category breakdown.
type CategoryShare struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

// OrderRow is one row of the user's order history.
type OrderRow struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Status   string `json:"status"`
	AmountPaise int        `json:"price_paise"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

// Note is a single admin-authored note on a user.
type Note struct {
	ID         string    `json:"id"`
	AdminEmail *string   `json:"admin_email,omitempty"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

// ListFilter captures table-level filters from the SPA.
type ListFilter struct {
	Search    string // matches name / phone / email
	Status    Status // empty = no filter
	Role      string // customer / pro / admin / "" = all
	IsVIP     *bool
	JoinedAfter *time.Time
	JoinedBefore *time.Time
	MinOrders int
	MinLTVCents int64
	SortBy    string // "joined_at" (default) | "total_orders" | "ltv_cents" | "name"
	SortDir   string // "asc" | "desc"
	Limit     int    // 1..200
	Offset    int
}

// ListResponse wraps a page + total count.
type ListResponse struct {
	Items      []ListItem `json:"items"`
	TotalCount int        `json:"total_count"`
	Limit      int        `json:"limit"`
	Offset     int        `json:"offset"`
}

// SuspendRequest is the body of POST /users/:id/suspend.
type SuspendRequest struct {
	Reason string `json:"reason" validate:"required,min=2,max=500"`
}

// BanRequest is the body of POST /users/:id/ban. The SPA enforces the typed
// "BAN USER" confirmation; the backend trusts the request because the SPA
// is the only client and the action is logged.
type BanRequest struct {
	Reason string `json:"reason" validate:"required,min=2,max=500"`
}

// VIPRequest is the body of POST /users/:id/vip.
type VIPRequest struct {
	IsVIP bool `json:"is_vip"`
}

// AddNoteRequest is the body of POST /users/:id/notes.
type AddNoteRequest struct {
	Body string `json:"body" validate:"required,min=1,max=2000"`
}
