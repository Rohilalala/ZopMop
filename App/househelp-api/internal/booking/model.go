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
