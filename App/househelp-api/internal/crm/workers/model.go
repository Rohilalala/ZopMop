// Package workers manages pro accounts (users.role='pro' joined to helpers).
// Reuses the user-side notes table (crm_user_notes) so a worker has one
// unified note thread regardless of which CRM page added them.
package workers

import "time"

// Status rolls up account state. Banned / suspended come from users; pending
// / rejected come from helpers.approval_status.
type Status string

const (
	StatusActive    Status = "active"     // approved + not suspended
	StatusPending   Status = "pending"    // helpers.approval_status='pending'
	StatusRejected  Status = "rejected"   // helpers.approval_status='rejected'
	StatusSuspended Status = "suspended"
	StatusBanned    Status = "banned"
)

// ListItem is a row in the workers table.
type ListItem struct {
	ID              string     `json:"id"`
	Phone           string     `json:"phone"`
	Name            *string    `json:"name,omitempty"`
	AvatarURL       *string    `json:"avatar_url,omitempty"`
	Status          Status     `json:"status"`
	IsAvailable     bool       `json:"is_available"`
	IsOnline        bool       `json:"is_online"` // is_available AND fresh location ping
	IsVIP           bool       `json:"is_vip"`
	Rating          float64    `json:"rating"`
	TotalJobs       int        `json:"total_jobs"`
	Categories      []string   `json:"categories"`
	JoinedAt        time.Time  `json:"joined_at"`
	LastActiveAt    *time.Time `json:"last_active_at,omitempty"`
}

// Detail is the per-worker drawer payload.
type Detail struct {
	ListItem
	Address          string  `json:"address"`
	CurrentLat       *float64 `json:"current_lat,omitempty"`
	CurrentLng       *float64 `json:"current_lng,omitempty"`
	SuspendReason    *string  `json:"suspend_reason,omitempty"`
	BanReason        *string  `json:"ban_reason,omitempty"`
	CompletedJobs30d int      `json:"completed_jobs_30d"`
	Earnings30dCents int64    `json:"earnings_30d_cents"`
	CancellationRate float64  `json:"cancellation_rate"`
	Locality         *string  `json:"locality,omitempty"`
}

// JobRow is one row of a worker's job history.
type JobRow struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Status   string `json:"status"`
	AmountPaise int        `json:"price_paise"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

// LivePin is the shape returned by the live-map endpoint.
type LivePin struct {
	ID         string  `json:"id"`
	Name       *string `json:"name,omitempty"`
	Phone      string  `json:"phone"`
	Lat        float64 `json:"lat"`
	Lng        float64 `json:"lng"`
	Rating     float64 `json:"rating"`
	JobStatus  string  `json:"job_status"` // "idle" | "en_route" | "on_job" | "offline"
	ActiveBookingID *string `json:"active_booking_id,omitempty"`
	UpdatedAt  *time.Time `json:"updated_at,omitempty"`
}

// ListFilter captures table-level filters for /workers.
type ListFilter struct {
	Search   string
	Status   Status
	Category string // single category match against helpers.services
	OnlyOnline bool
	SortBy   string // "joined_at" | "total_jobs" | "rating" | "name"
	SortDir  string
	Limit    int
	Offset   int
}

// ListResponse mirrors the user list response.
type ListResponse struct {
	Items      []ListItem `json:"items"`
	TotalCount int        `json:"total_count"`
	Limit      int        `json:"limit"`
	Offset     int        `json:"offset"`
}

// SuspendRequest mirrors users — same shape, separate type for clarity.
type SuspendRequest struct {
	Reason string `json:"reason" validate:"required,min=2,max=500"`
}

// RejectRequest captures the reason an application is rejected.
type RejectRequest struct {
	Reason string `json:"reason" validate:"required,min=2,max=500"`
}

// SetCategoriesRequest is the body of POST /workers/:id/categories.
type SetCategoriesRequest struct {
	Categories []string `json:"categories"`
}
