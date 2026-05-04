package leave

import "time"

// IST is the timezone the 9pm cutoff is evaluated against. Pros are in India,
// so the leave window is local-IST regardless of the server's clock.
var IST = func() *time.Location {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		// Fallback: hardcoded +05:30. Should never happen in practice but
		// avoids a panic if the host is missing zoneinfo.
		return time.FixedZone("IST", 5*3600+30*60)
	}
	return loc
}()

// Cutoff hour (24h, IST). After this, leave for tomorrow is blocked.
const CutoffHour = 21

// DefaultMonthlyQuota — every helper starts with this many leave days per
// month, replenished on the 1st via the lazy-reset path in Service.Balance.
const DefaultMonthlyQuota = 2

// LeaveStatus values.
const (
	StatusApproved  = "approved"
	StatusCancelled = "cancelled"
)

// LeaveSource values — distinguishes self-declared from admin-allocated.
const (
	SourcePro   = "pro"
	SourceAdmin = "admin"
)

// Leave is one row in pro_leaves.
type Leave struct {
	ID         string    `json:"id"`
	ProID      string    `json:"pro_id"`
	Date       time.Time `json:"date"`
	DeclaredAt time.Time `json:"declared_at"`
	Status     string    `json:"status"`
	Source     string    `json:"source"`
	Note       string    `json:"note,omitempty"`
}

// Balance is the public balance shape returned to pros.
type Balance struct {
	Balance   int       `json:"balance"`
	Used      int       `json:"used"`
	Quota     int       `json:"quota"`
	ResetDate time.Time `json:"reset_date"`
}

// Reassignment outcome for one affected booking. Used by tests + the
// CRM-notification payload that gets fired when a booking is cancelled.
type ReassignOutcome struct {
	BookingID    string `json:"booking_id"`
	NewProID     string `json:"new_pro_id,omitempty"`
	Cancelled    bool   `json:"cancelled"`
	CustomerName string `json:"customer_name,omitempty"`
	ServiceName  string `json:"service_name,omitempty"`
	ScheduledAt  string `json:"scheduled_at,omitempty"`
}
