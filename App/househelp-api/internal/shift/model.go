package shift

import (
	"errors"
	"time"
)

// Pay constants (paise — 100 paise = ₹1). Held in code rather than
// config_manager for the first cut — moved to runtime config once
// the rates are confirmed stable in production.
const (
	BaseRatePaisePerHour     = 8000  // ₹80
	OvertimeRatePaisePerHour = 9000  // ₹90 (above weekly_hours_target)
	AbsenceCashPenaltyPaise  = 30000 // ₹300 for no-commit-by-3am when no leave balance
	OnTimeGraceMinutes       = 30    // Go Online window after committed start without late_show flag
	LateGraceForLateShow     = 30    // mirror; spec uses one value
	ZoneRadiusMeters         = 1000  // 1km verification radius
	StrikeThreshold          = 5     // cancellations 1-4 free, 5+ deduct
	StrikeWindowDays         = 30    // rolling window
)

// Public errors mapped to HTTP status codes by the handler.
var (
	ErrShiftDateInPast      = errors.New("shift date must be in the future")
	ErrShiftAfterLockWindow = errors.New("shift already locked (past 3 AM IST)")
	ErrShiftOverlap         = errors.New("shift overlaps an existing committed shift")
	ErrShiftBounds          = errors.New("shift bounds invalid (end before start, or duration > 16 hours)")
	ErrCommitmentNotFound   = errors.New("commitment not found")
	ErrCommitmentLocked     = errors.New("commitment already locked; cannot edit")
	ErrShiftNotActive       = errors.New("shift is not active yet")
	ErrAlreadyOnline        = errors.New("pro is already online for this shift")
	ErrNotOnline            = errors.New("pro is not currently online")
	ErrBookingsPending      = errors.New("cannot go offline while bookings are pending")
	ErrOutsideZone          = errors.New("current location is outside the assigned zone")
	ErrNoZoneAssigned       = errors.New("pro has no active zone assignment")
	ErrApprovalPending      = errors.New("a zone approval is already pending")
	ErrBookingNotOwnedByPro = errors.New("booking is not owned by this pro")
	// ErrAlreadyReviewed — DecideZoneApproval matched 0 rows because the
	// request was already approved/rejected (admin race). Handler maps to 409.
	ErrAlreadyReviewed = errors.New("zone approval already reviewed")
	// ErrBookingNotCancellable — the cancel UPDATE matched 0 rows because
	// the booking was no longer in a cancellable ('accepted') state: a
	// double-tap, a timeout-retry, or a job already completed/cancelled.
	// Handler maps to 409. This is the status-guard + idempotency gate.
	ErrBookingNotCancellable = errors.New("booking is not in a cancellable state")
)

// Commitment is the public view of one shift_commitments row.
type Commitment struct {
	ID              string     `json:"id"`
	ProID           string     `json:"pro_id"`
	ShiftDate       string     `json:"shift_date"`  // YYYY-MM-DD
	StartTime       string     `json:"start_time"`  // HH:MM
	EndTime         string     `json:"end_time"`    // HH:MM
	Status          string     `json:"status"`
	LockedAt        *time.Time `json:"locked_at,omitempty"`
	OnlineStartedAt *time.Time `json:"online_started_at,omitempty"`
	OnlineEndedAt   *time.Time `json:"online_ended_at,omitempty"`
	LateShow        bool       `json:"late_show"`
}

// Session is the public view of one shift_sessions row.
type Session struct {
	ID                       string     `json:"id"`
	CommitmentID             string     `json:"commitment_id"`
	OnlineAt                 time.Time  `json:"online_at"`
	OfflineAt                *time.Time `json:"offline_at,omitempty"`
	OnlineMinutes            *int       `json:"online_minutes,omitempty"`
	JobMinutes               int        `json:"job_minutes"`
	LocationVerifiedAtStart  bool       `json:"location_verified_at_start"`
	ManualApprovalUsed       bool       `json:"manual_approval_used"`
}

// CommitRequest is the body of POST /pro/commitments.
type CommitRequest struct {
	ShiftDate string `json:"shift_date" validate:"required"` // YYYY-MM-DD
	StartTime string `json:"start_time" validate:"required"` // HH:MM
	EndTime   string `json:"end_time"   validate:"required"` // HH:MM
}

// GoOnlineRequest carries the current GPS reading.
type GoOnlineRequest struct {
	Lat float64 `json:"lat" validate:"required,latitude"`
	Lng float64 `json:"lng" validate:"required,longitude"`
}

// GoOnlineResult signals to the app whether the location check passed
// and whether to open the manual-approval flow.
type GoOnlineResult struct {
	SessionID              string  `json:"session_id,omitempty"`
	LocationOK             bool    `json:"location_ok"`
	RequiresManualApproval bool    `json:"requires_manual_approval"`
	DistanceMeters         float64 `json:"distance_meters,omitempty"`
	// ApprovalPending is true when a zone-approval request for this
	// commitment is already queued — the app should route to the
	// "waiting for approval" state, not ask the pro to upload a selfie
	// again (a resubmit would 409 ErrApprovalPending).
	ApprovalPending bool `json:"approval_pending,omitempty"`
}

// ZoneApprovalRequestBody — POST /pro/shifts/:id/zone-approval-request.
type ZoneApprovalRequestBody struct {
	Lat      float64 `json:"lat"       validate:"required,latitude"`
	Lng      float64 `json:"lng"       validate:"required,longitude"`
	PhotoURL string  `json:"photo_url" validate:"required"`
}

// FortnightProgress — GET /pro/fortnight/progress.
//
// DeductionsPaise / `deductions_paise` is the legacy aggregate; new
// clients should read the split fields. The aggregate stays wired so
// existing callers don't break mid-rollout.
type FortnightProgress struct {
	FortnightStart            string `json:"fortnight_start"`
	FortnightEnd              string `json:"fortnight_end"`
	OnlineMinutes             int    `json:"online_minutes"`
	TargetMinutes             int    `json:"target_minutes"`
	OvertimeMinutes           int    `json:"overtime_minutes"`
	JobMinutes                int    `json:"job_minutes"`
	OnlinePayPaise            int    `json:"online_pay_paise"`
	OvertimePayPaise          int    `json:"overtime_pay_paise"`
	JobPayPaise               int    `json:"job_pay_paise"`
	AbsenceDeductionsPaise    int    `json:"absence_deductions_paise"`
	CancellationDeductionsPaise int  `json:"cancellation_deductions_paise"`
	DeductionsPaise           int    `json:"deductions_paise"`
	TotalDeductionsPaise      int    `json:"total_deductions_paise"`
	ProjectedPayPaise         int    `json:"projected_pay_paise"`
	CancellationCount30d      int    `json:"cancellation_count_30d"`
	LeaveBalance              int    `json:"leave_balance"`
}

// CancelBookingRequest — POST /pro/bookings/:id/cancel.
type CancelBookingRequest struct {
	Reason string `json:"reason" validate:"omitempty,max=200"`
}

// CancelBookingResult tells the app whether the strike threshold
// kicked in and how much was deducted.
type CancelBookingResult struct {
	CancellationIndex30d int  `json:"cancellation_index_30d"`
	PenaltyApplied       bool `json:"penalty_applied"`
	PenaltyAmountPaise   int  `json:"penalty_amount_paise"`
}

// ZoneApprovalRequest — admin view of one row. Fields below the core set
// (pro_name, pro_phone, assigned_zone_*, distance_meters) are populated only
// by ListPendingZoneApprovals; the pro-app insert path leaves them empty.
type ZoneApprovalRequest struct {
	ID                string    `json:"id"`
	ProID             string    `json:"pro_id"`
	ShiftCommitmentID string    `json:"shift_commitment_id"`
	RequestedAt       time.Time `json:"requested_at"`
	CurrentLat        float64   `json:"current_lat"`
	CurrentLng        float64   `json:"current_lng"`
	PhotoURL          string    `json:"photo_url,omitempty"`
	Status            string    `json:"status"`
	Notes             string    `json:"notes,omitempty"`

	// Enrichment for /admin/zone-approvals (Phase 11B Step 1 review UI).
	// Nullable / omit-when-empty so the pro-app insert response stays the
	// minimal shape it always was.
	ProName              *string  `json:"pro_name,omitempty"`
	ProPhone             *string  `json:"pro_phone,omitempty"`
	AssignedZoneID       *string  `json:"assigned_zone_id,omitempty"`
	AssignedZoneName     *string  `json:"assigned_zone_name,omitempty"`
	AssignedZoneLat      *float64 `json:"assigned_zone_lat,omitempty"`
	AssignedZoneLng      *float64 `json:"assigned_zone_lng,omitempty"`
	AssignedZoneRadiusKm *float64 `json:"assigned_zone_radius_km,omitempty"`
	DistanceMeters       *float64 `json:"distance_meters,omitempty"`
}
