package matching

import "time"

// HelperMatch is the final, scored result returned to callers.
type HelperMatch struct {
	HelperID       string  `json:"helper_id"`
	DistanceKm     float64 `json:"distance_km"`
	Rating         float64 `json:"rating"`
	TotalJobs      int     `json:"total_jobs"`
	ActiveBookings int     `json:"active_bookings"`
	Score          float64 `json:"score"`
}

// MatchRequest is used by callers (e.g. booking service) to request matching.
type MatchRequest struct {
	BookingID  string  `json:"booking_id"`
	CustomerID string  `json:"customer_id"`
	Lat        float64 `json:"lat"`
	Lng        float64 `json:"lng"`
	// RadiusKm is optional; 0 means use config default.
	RadiusKm float64 `json:"radius_km"`
}

// HelperCandidate is an intermediate representation during the scoring pipeline.
type HelperCandidate struct {
	HelperID       string
	Lat            float64
	Lng            float64
	DistanceKm     float64
	Rating         float64
	TotalJobs      int
	ActiveBookings int
	Score          float64 // filled by scorer
}

// BatchEntry represents a pending booking request waiting in the batch queue.
type BatchEntry struct {
	BookingID  string
	CustomerID string
	Lat        float64
	Lng        float64
	CellID     string    // hex cell at booking coords
	EnqueuedAt time.Time
}

// DemandCell is one entry in the demand heatmap response.
type DemandCell struct {
	CellID   string  `json:"cell_id"`
	Count    float64 `json:"count"`
	CenterLat float64 `json:"center_lat"`
	CenterLng float64 `json:"center_lng"`
}
