package booking

import "time"

// BookingStatus is a typed enum for booking statuses.
type BookingStatus string

const (
	StatusPending    BookingStatus = "pending"
	// StatusSearching is set by the StealthDispatcher after it claims a
	// new instant booking and before it emits the FCM invites. Pros that
	// receive the invite call AcceptBooking, which now accepts both
	// 'pending' (scheduled flow) and 'searching' (stealth flow) as the
	// pre-assignment state.
	StatusSearching  BookingStatus = "searching"
	StatusAccepted   BookingStatus = "accepted"
	StatusInProgress BookingStatus = "in_progress"
	StatusCompleted  BookingStatus = "completed"
	StatusCancelled  BookingStatus = "cancelled"
)

// IsCancellableStatus reports whether the supplied BookingStatus is one of
// the states from which a customer or pro may cancel via
// POST /bookings/:id/cancel. Pure function over the enum; substate guards
// (the en_route_at / arrived_at timestamps that further restrict
// status='accepted') live in IsCancellable.
//
// Truth table — pinned by cancel_truth_table_test.go so a future enum
// addition forces a deliberate review here instead of silently
// inheriting a default:
//
//   pending      cancellable     (customer hasn't been matched)
//   searching    NOT cancellable (matching engine actively dispatching)
//   accepted     cancellable     (pro accepted but hasn't committed
//                                 to the trip yet — substates further
//                                 restrict; see IsCancellable)
//   in_progress  NOT cancellable (service has STARTED; the only out is
//                                 admin force-complete via CRM. A pro-
//                                 self-service cancel here would silently
//                                 bypass the customer-block escape hatch.
//                                 See docs/phase-1-payment-gated-flow.md.)
//   completed    NOT cancellable (terminal)
//   cancelled    NOT cancellable (already terminal)
//
// Unknown / future statuses default to NOT cancellable. The test asserts
// this so a regression that silently allows a new status is impossible.
func IsCancellableStatus(s BookingStatus) bool {
	switch s {
	case StatusPending, StatusAccepted:
		return true
	case StatusSearching, StatusInProgress, StatusCompleted, StatusCancelled:
		return false
	}
	return false
}

// IsCancellable applies the full cancel rule: status truth table PLUS
// the accepted-substate guards. Even within status='accepted', once the
// pro has committed to the trip (en_route_at set) or arrived
// (arrived_at set), the pro-self-service cancel is no longer available.
// The only out from that point is admin force-complete via the CRM
// (mark-complete-as-unpaid → customer block fires).
//
// This is the function CancelBooking uses. IsCancellableStatus is the
// status-only subset, exposed because the truth-table test pins the
// enum behaviour separately from the substate behaviour.
func IsCancellable(b *Booking) bool {
	if b == nil {
		return false
	}
	if !IsCancellableStatus(b.Status) {
		return false
	}
	if b.Status == StatusAccepted {
		if b.EnRouteAt != nil || b.ArrivedAt != nil {
			return false
		}
	}
	return true
}

// Booking represents a service booking.
// Amount is always stored as integer paise to avoid floating point errors.
type Booking struct {
	ID                     string        `json:"id"`
	CustomerID             string        `json:"customer_id"`
	HelperID               *string       `json:"helper_id,omitempty"`
	ServiceCategoryID      string        `json:"service_category_id"`
	Status                 BookingStatus `json:"status"`
	Address                string        `json:"address"`
	Lat                    float64       `json:"lat"`
	Lng                    float64       `json:"lng"`
	AmountPaise            int           `json:"price_paise"`
	PromoCode              *string       `json:"promo_code,omitempty"`
	DiscountPaise          int           `json:"discount_paise"`
	ScheduledTime          *time.Time    `json:"scheduled_time,omitempty"`
	CancelledAt            *time.Time    `json:"cancelled_at,omitempty"`
	CancellationFeeApplied bool          `json:"cancellation_fee_applied"`
	CancellationFeeCents   int           `json:"cancellation_fee_paise"`
	// Phase 10 lifecycle timestamps. NULL until the pro reaches that step.
	AcceptedAt            *time.Time `json:"accepted_at,omitempty"`
	EnRouteAt             *time.Time `json:"en_route_at,omitempty"`
	ArrivedAt             *time.Time `json:"arrived_at,omitempty"`
	StartedAt             *time.Time `json:"started_at,omitempty"`
	CompletedAt           *time.Time `json:"completed_at,omitempty"`
	ProEarningsPaise      int        `json:"pro_earnings_paise,omitempty"`
	ActualDurationMinutes *int       `json:"actual_duration_minutes,omitempty"`
	CustomerRatingPending bool       `json:"customer_rating_pending,omitempty"`
	// Two-OTP payment-gated service flow (Phase 1 Step 1, migration 112).
	// StartOTPVerifiedAt is stamped when the pro submits the correct start OTP
	// at the accepted->in_progress transition. EndOTPVerifiedAt is stamped at
	// the in_progress->completed transition. CashCollectedByPro + CashCollectedAt
	// record a "paid by cash" event by the pro (orthogonal to Cashfree); the
	// pro owes that amount to the company until settled by an admin in CRM.
	StartOTPVerifiedAt  *time.Time `json:"start_otp_verified_at,omitempty"`
	EndOTPVerifiedAt    *time.Time `json:"end_otp_verified_at,omitempty"`
	CashCollectedByPro  *string    `json:"cash_collected_by_pro,omitempty"`
	CashCollectedAt     *time.Time `json:"cash_collected_at,omitempty"`
	// Phase 1 Step 3 — cash settlement tracking (migration 113). Stamped
	// when an admin clicks "Mark settled" in the CRM, recording the
	// hand-over of physical cash from the pro to the company.
	CashSettledAt       *time.Time `json:"cash_settled_at,omitempty"`
	CashSettledByAdmin  *string    `json:"cash_settled_by_admin,omitempty"`
	// CanCancelFree and FreeCancelUntil are computed at read time on the
	// booking detail endpoint. nil for terminal-state bookings (no longer
	// cancellable).
	CanCancelFree   *bool      `json:"can_cancel_free,omitempty"`
	FreeCancelUntil *time.Time `json:"free_cancel_until,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// BookingDetail is the enriched response returned by GET /bookings/:id.
// It embeds the base Booking plus the resolved helper (when assigned) and
// the per-service line items with their lifecycle status. The customer app
// renders TrackLiveScreen entirely from this shape — no follow-up calls.
type BookingDetail struct {
	Booking
	Helper   *BookingDetailHelper  `json:"helper,omitempty"`
	Services []BookingDetailService `json:"services"`
}

// BookingDetailHelper is the customer-facing slice of the assigned pro.
// Phone is middle-masked (98XXXXX210) until the booking is accepted; the
// full unmasked number is returned post-accept so the customer can call.
type BookingDetailHelper struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Phone     string  `json:"phone"`
	Rating    float64 `json:"rating"`
	TotalJobs int     `json:"total_jobs"`
	PhotoURL  string  `json:"photo_url,omitempty"`
}

// BookingDetailService is one service line within a booking with its
// per-service status. display_order is the canonical sort key for the
// task checklist UI.
type BookingDetailService struct {
	ServiceID       string     `json:"service_id"`
	ServiceName     string     `json:"service_name"`
	DurationMinutes int        `json:"duration_minutes"`
	PricePaise      int        `json:"price_paise"`
	Status          string     `json:"status"` // pending | in_progress | completed | skipped
	DisplayOrder    int        `json:"display_order"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	SkipReason      *string    `json:"skip_reason,omitempty"`
}

// MaskPhone returns a middle-masked phone string for display before the
// pro accepts. Strips leading +91 / 91 country code, keeps the first 2 and
// last 3 of the 10-digit national number, and X-pads the middle.
// Returns the input untouched when it doesn't look like a 10-digit number.
func MaskPhone(raw string) string {
	// Strip non-digits.
	digits := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] >= '0' && raw[i] <= '9' {
			digits = append(digits, raw[i])
		}
	}
	// Drop leading 91 country code if present and we have 12 digits.
	if len(digits) == 12 && digits[0] == '9' && digits[1] == '1' {
		digits = digits[2:]
	}
	if len(digits) != 10 {
		return raw
	}
	return string(digits[:2]) + "XXXXX" + string(digits[7:])
}

// CancelBookingResponse is returned by DELETE /bookings/:id.
type CancelBookingResponse struct {
	Message                string `json:"message"`
	CancellationFeeApplied bool   `json:"cancellation_fee_applied"`
	CancellationFeeCents   int    `json:"cancellation_fee_paise"`
}

// CreateBookingRequest is the input for creating a new booking.
//
// PaymentSource selects the funding rail. Empty / "direct" uses the
// existing Cashfree-or-COD path; "wallet" debits the closed-loop wallet
// inline. Wallet path requires sufficient balance — caller gets a 402 with
// code "insufficient_wallet_balance" when short.
type CreateBookingRequest struct {
	ServiceCategoryID string  `json:"service_category_id" validate:"required,uuid_format"`
	Address           string  `json:"address" validate:"required,min=5,max=500"`
	Lat               float64 `json:"lat" validate:"required,latitude"`
	Lng               float64 `json:"lng" validate:"required,longitude"`
	PromoCode         string  `json:"promo_code,omitempty" validate:"omitempty,max=50"`
	PaymentSource     string  `json:"payment_source,omitempty" validate:"omitempty,oneof=direct wallet"`
}

// CancelBookingRequest is the input for cancelling a booking.
type CancelBookingRequest struct {
	Reason string `json:"reason,omitempty" validate:"max=500"`
}

// BookingServiceItem represents one service line within a scheduled booking.
type BookingServiceItem struct {
	ServiceID       string `json:"service_id"`
	ServiceName     string `json:"service_name"`
	DurationMinutes int    `json:"duration_minutes"`
	PriceCents      int    `json:"price_paise"`
}

// ScheduledBooking is the response for the new scheduling flow, includes
// the list of services and the resolved time slot.
type ScheduledBooking struct {
	ID                   string               `json:"id"`
	CustomerID           string               `json:"customer_id"`
	AddressID            *string              `json:"address_id,omitempty"`
	AddressTag           *string              `json:"address_tag,omitempty"`   // "Home"/"Work"/"Other"
	AddressTitle         *string              `json:"address_title,omitempty"` // free-text label
	TimeSlotID           *string              `json:"time_slot_id,omitempty"`
	ScheduledTime        *string              `json:"scheduled_time,omitempty"` // RFC3339
	TotalDurationMinutes int                  `json:"total_duration_minutes"`
	Services             []BookingServiceItem `json:"services"`
	Status               BookingStatus        `json:"status"`
	AmountPaise          int                  `json:"price_paise"`
	DiscountPaise        int                  `json:"discount_paise"`
	PromoCode     *string             `json:"promo_code,omitempty"`
	CreatedAt     time.Time           `json:"created_at"`
}

// CreateScheduledBookingRequest is the input for the new booking flow.
type CreateScheduledBookingRequest struct {
	AddressID     string `json:"address_id"  validate:"required,uuid_format"`
	TimeSlotID    string `json:"time_slot_id" validate:"required,uuid_format"`
	PromoCode     string `json:"promo_code,omitempty" validate:"omitempty,max=50"`
	PaymentSource string `json:"payment_source,omitempty" validate:"omitempty,oneof=direct wallet"`
}

// CreateInstantBookingRequest is the input for POST /bookings/instant.
// Cart items are read server-side; only the delivery address is required.
type CreateInstantBookingRequest struct {
	AddressID     string `json:"address_id" validate:"required,uuid_format"`
	PaymentSource string `json:"payment_source,omitempty" validate:"omitempty,oneof=direct wallet"`
}

// MatchStatusResponse is returned by GET /bookings/:id/match-status.
type MatchStatusResponse struct {
	Status        string         `json:"status"` // "searching" | "matched" | "failed"
	Helper        *MatchedHelper `json:"helper,omitempty"`
	BookingStatus string         `json:"booking_status,omitempty"` // pending|searching|dispatching|accepted|arrived|in_progress|completed|cancelled
	// Phase 10 sub-state booleans derived from the lifecycle timestamp
	// columns. The customer app uses these instead of the coarse status
	// to drive the TrackLiveScreen state machine.
	EnRoute    bool `json:"en_route,omitempty"`
	Arrived    bool `json:"arrived,omitempty"`
	InProgress bool `json:"in_progress,omitempty"`
	Completed  bool `json:"completed,omitempty"`
}

// MatchedHelper contains the assigned helper's details once a booking is accepted.
type MatchedHelper struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Phone      string  `json:"phone"`
	Rating     float64 `json:"rating"`
	ETAMinutes int     `json:"eta_minutes"`
	Lat        float64 `json:"lat,omitempty"`
	Lng        float64 `json:"lng,omitempty"`
	PhotoURL   string  `json:"photo_url,omitempty"`
	TotalJobs  int     `json:"total_jobs"`
}

// TrackingResponse is returned by GET /bookings/:id/tracking.
// It contains the helper's live location, the customer's location, a walking
// ETA and an encoded Google Maps polyline for the route.
//
// Phase 1 Step 2: the customer-facing TrackLive screen also reads the two
// service OTP codes from this response. Both are populated only when an
// outstanding code exists in Redis (see internal/otp); when empty the app
// hides the OTP display chip. Peek is read-only — querying TrackLive does
// not consume the codes; only the pro's StartBooking / CompleteBooking
// calls do.
//
//   - StartOTPCode appears once the pro taps "On my way" (MarkEnRoute) and
//     disappears once the pro consumes it via StartBooking.
//   - EndOTPCode appears once payment resolves (Cashfree webhook 'paid' or
//     cash-marked in Step 3) and disappears once the pro consumes it via
//     CompleteBooking.
type TrackingResponse struct {
	HelperLat       float64 `json:"helper_lat"`
	HelperLng       float64 `json:"helper_lng"`
	CustomerLat     float64 `json:"customer_lat"`
	CustomerLng     float64 `json:"customer_lng"`
	ETAMinutes      int     `json:"eta_minutes"`
	EncodedPolyline string  `json:"polyline"`
	LastUpdatedAt   string  `json:"last_updated_at"` // ISO8601
	// Phase 1 Step 2 — booking-scoped service OTPs. Empty string when no
	// outstanding code; the app must treat empty as "no code to display".
	StartOTPCode string `json:"start_otp_code,omitempty"`
	EndOTPCode   string `json:"end_otp_code,omitempty"`
}
