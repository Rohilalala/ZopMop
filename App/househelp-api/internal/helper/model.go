package helper

import "time"

// Profile is the helper's own profile as returned by GET /helpers/me/profile.
type Profile struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Phone       string    `json:"phone"`
	Rating      float64   `json:"rating"`
	TotalJobs   int       `json:"total_jobs"`
	IsAvailable bool      `json:"is_available"`
	CreatedAt   time.Time `json:"created_at"`
}

// Invite is a booking the matching engine has proposed to this helper.
type Invite struct {
	BookingID    string    `json:"booking_id"`
	CustomerName string    `json:"customer_name"`
	Address      string    `json:"address"`
	Lat          float64   `json:"lat"`
	Lng          float64   `json:"lng"`
	Services     []string  `json:"services"`
	TotalMinutes int       `json:"total_minutes"`
	AmountPaise  int       `json:"price_cents"`
	CreatedAt   time.Time `json:"created_at"`
}

// LocationUpdateRequest is the payload for PUT /helpers/me/location.
type LocationUpdateRequest struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// StatusUpdateRequest is the payload for PUT /helpers/me/status.
type StatusUpdateRequest struct {
	IsAvailable bool `json:"is_available"`
}
