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
