package booking

import "time"

// BookingStatus is a typed enum for booking statuses.
type BookingStatus string

const (
	StatusPending    BookingStatus = "pending"
	StatusAccepted   BookingStatus = "accepted"
	StatusInProgress BookingStatus = "in_progress"
	StatusCompleted  BookingStatus = "completed"
	StatusCancelled  BookingStatus = "cancelled"
)

// Booking represents a service booking.
// Price is always stored as integer cents to avoid floating point errors.
type Booking struct {
	ID                string        `json:"id"`
	CustomerID        string        `json:"customer_id"`
	HelperID          *string       `json:"helper_id,omitempty"`
	ServiceCategoryID string        `json:"service_category_id"`
	Status            BookingStatus `json:"status"`
	Address           string        `json:"address"`
	Lat               float64       `json:"lat"`
	Lng               float64       `json:"lng"`
	PriceCents        int           `json:"price_cents"`
	PromoCode         *string       `json:"promo_code,omitempty"`
	DiscountCents     int           `json:"discount_cents"`
	CreatedAt         time.Time     `json:"created_at"`
	UpdatedAt         time.Time     `json:"updated_at"`
}

// CreateBookingRequest is the input for creating a new booking.
type CreateBookingRequest struct {
	ServiceCategoryID string  `json:"service_category_id" validate:"required,uuid_format"`
	Address           string  `json:"address" validate:"required,min=5,max=500"`
	Lat               float64 `json:"lat" validate:"required,latitude"`
	Lng               float64 `json:"lng" validate:"required,longitude"`
	PromoCode         string  `json:"promo_code,omitempty" validate:"omitempty,max=50"`
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
	PriceCents      int    `json:"price_cents"`
}

// ScheduledBooking is the response for the new scheduling flow, includes
// the list of services and the resolved time slot.
type ScheduledBooking struct {
	ID                   string               `json:"id"`
	CustomerID           string               `json:"customer_id"`
	AddressID            *string              `json:"address_id,omitempty"`
	TimeSlotID           *string              `json:"time_slot_id,omitempty"`
	ScheduledTime        *string              `json:"scheduled_time,omitempty"` // RFC3339
	TotalDurationMinutes int                  `json:"total_duration_minutes"`
	Services             []BookingServiceItem `json:"services"`
	Status               BookingStatus        `json:"status"`
	PriceCents           int                  `json:"price_cents"`
	DiscountCents        int                  `json:"discount_cents"`
	PromoCode            *string              `json:"promo_code,omitempty"`
	CreatedAt            time.Time            `json:"created_at"`
}

// CreateScheduledBookingRequest is the input for the new booking flow.
type CreateScheduledBookingRequest struct {
	AddressID  string `json:"address_id"  validate:"required,uuid_format"`
	TimeSlotID string `json:"time_slot_id" validate:"required,uuid_format"`
	PromoCode  string `json:"promo_code,omitempty" validate:"omitempty,max=50"`
}

// CreateInstantBookingRequest is the input for POST /bookings/instant.
// Cart items are read server-side; only the delivery address is required.
type CreateInstantBookingRequest struct {
	AddressID string `json:"address_id" validate:"required,uuid_format"`
}

// MatchStatusResponse is returned by GET /bookings/:id/match-status.
type MatchStatusResponse struct {
	Status string         `json:"status"` // "searching" | "matched" | "failed"
	Helper *MatchedHelper `json:"helper,omitempty"`
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
