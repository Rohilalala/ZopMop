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
type TrackingResponse struct {
	HelperLat       float64 `json:"helper_lat"`
	HelperLng       float64 `json:"helper_lng"`
	CustomerLat     float64 `json:"customer_lat"`
	CustomerLng     float64 `json:"customer_lng"`
	ETAMinutes      int     `json:"eta_minutes"`
	EncodedPolyline string  `json:"polyline"`
	LastUpdatedAt   string  `json:"last_updated_at"` // ISO8601
}
