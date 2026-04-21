package analytics

import "time"

// ── Backend event names ───────────────────────────────────────────────────────
// Emitted by the service layer on booking lifecycle transitions and matching.
const (
	EventBookingCreated   = "booking.created"
	EventBookingAccepted  = "booking.accepted"
	EventBookingStarted   = "booking.started"
	EventBookingCompleted = "booking.completed"
	EventBookingCancelled = "booking.cancelled"
	EventMatchingTimeout  = "matching.timeout"
	EventHelperOnline     = "helper.went_online"
	EventHelperOffline    = "helper.went_offline"
)

// ── Client-side funnel event names ───────────────────────────────────────────
// Ingested from the mobile app via POST /api/v1/analytics/events.
// Only these names are accepted; all others are rejected to prevent spam.
const (
	EventAppOpened             = "app.opened"
	EventServiceViewed         = "service.viewed"
	EventCartItemAdded         = "cart.item_added"
	EventCartItemRemoved       = "cart.item_removed"
	EventBookingFlowStarted    = "booking_flow.started"
	EventBookingFlowAddressSet = "booking_flow.address_set"
	EventBookingFlowSlotPicked = "booking_flow.slot_picked"
	EventBookingFlowDropped    = "booking_flow.dropped"
)

// AllowedClientEvents is the whitelist for mobile-ingested event names.
var AllowedClientEvents = map[string]bool{
	EventAppOpened:             true,
	EventServiceViewed:         true,
	EventCartItemAdded:         true,
	EventCartItemRemoved:       true,
	EventBookingFlowStarted:    true,
	EventBookingFlowAddressSet: true,
	EventBookingFlowSlotPicked: true,
	EventBookingFlowDropped:    true,
}

// ── Request / response types ──────────────────────────────────────────────────

// ClientEventRequest is the body for POST /api/v1/analytics/events.
type ClientEventRequest struct {
	EventName  string            `json:"event_name"  validate:"required,max=100"`
	BookingID  string            `json:"booking_id,omitempty"`
	Properties map[string]string `json:"properties,omitempty"`
}

// EventLocation contains coarse location context for canonical client events.
type EventLocation struct {
	Lat  *float64 `json:"lat"`
	Lng  *float64 `json:"lng"`
	Area string   `json:"area"`
}

// CanonicalEventRequest is the body for POST /api/v1/events.
type CanonicalEventRequest struct {
	EventName    string                 `json:"event_name"`
	EventID      string                 `json:"event_id"`
	EventVersion string                 `json:"event_version"`
	UserID       string                 `json:"user_id"`
	HelperID     *string                `json:"helper_id"`
	Timestamp    string                 `json:"timestamp"`
	Location     EventLocation          `json:"location"`
	Device       string                 `json:"device"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
	Properties   map[string]interface{} `json:"properties,omitempty"`
}

// OverviewResponse is the KPI snapshot returned by GET /admin/analytics/overview.
type OverviewResponse struct {
	Period             string  `json:"period"`
	TotalBookings      int     `json:"total_bookings"`
	CompletedBookings  int     `json:"completed_bookings"`
	CancelledBookings  int     `json:"cancelled_bookings"`
	PendingBookings    int     `json:"pending_bookings"`
	CompletionRate     float64 `json:"completion_rate"`    // completed / (completed + cancelled)
	MatchSuccessRate   float64 `json:"match_success_rate"` // accepted+started+completed / total
	TotalRevenueCents  int64   `json:"total_revenue_cents"`
	AvgOrderValueCents int64   `json:"avg_order_value_cents"`
	ActiveHelpers      int     `json:"active_helpers"`
	NewUsers           int     `json:"new_users"`
}

// FunnelStep is one stage in the booking conversion funnel.
type FunnelStep struct {
	Step          string  `json:"step"`
	EventName     string  `json:"event_name"`
	Count         int     `json:"count"`
	ConversionPct float64 `json:"conversion_pct"` // percentage of the previous step's count
}

// FunnelResponse is returned by GET /admin/analytics/funnel.
type FunnelResponse struct {
	Period string       `json:"period"`
	Steps  []FunnelStep `json:"steps"`
}

// BookingTrendDay is one row in the booking trend chart.
type BookingTrendDay struct {
	Date      string `json:"date"`
	Created   int    `json:"created"`
	Completed int    `json:"completed"`
	Cancelled int    `json:"cancelled"`
}

// WorkerMetrics holds per-helper performance data.
type WorkerMetrics struct {
	HelperID       string  `json:"helper_id"`
	Name           string  `json:"name"`
	TotalAssigned  int     `json:"total_assigned"`
	TotalCompleted int     `json:"total_completed"`
	TotalCancelled int     `json:"total_cancelled"`
	CompletionRate float64 `json:"completion_rate"`
	AvgResponseSec float64 `json:"avg_response_seconds"` // booking.created → accepted
	AvgJobMinutes  float64 `json:"avg_job_minutes"`      // started → completed
	Rating         float64 `json:"rating"`
}

// OperationalMetrics holds system-level timing and efficiency data.
type OperationalMetrics struct {
	Period              string  `json:"period"`
	AvgTimeToAssignSec  float64 `json:"avg_time_to_assign_seconds"`
	AvgJobDurationMin   float64 `json:"avg_job_duration_minutes"`
	MatchSuccessRate    float64 `json:"match_success_rate"`
	AutoExpiredBookings int     `json:"auto_expired_bookings"`
	TotalMatchAttempts  int     `json:"total_match_attempts"`
}

// RevenueTrendDay is one row in the revenue trend chart.
type RevenueTrendDay struct {
	Date              string `json:"date"`
	GrossRevenueCents int64  `json:"gross_revenue_cents"`
	DiscountCents     int64  `json:"discount_cents"`
	NetRevenueCents   int64  `json:"net_revenue_cents"`
	BookingCount      int    `json:"booking_count"`
}

// Event is a single record in analytics_events (returned in raw event queries).
type Event struct {
	ID         string            `json:"id"`
	EventName  string            `json:"event_name"`
	UserID     *string           `json:"user_id,omitempty"`
	BookingID  *string           `json:"booking_id,omitempty"`
	Properties map[string]string `json:"properties"`
	CreatedAt  time.Time         `json:"created_at"`
}
