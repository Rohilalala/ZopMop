package matching

// HelperMatch is a legacy scored result persisted in the Redis match:b:* keys.
// The scoring pipeline that produced these is retired (spec §9); the type
// survives only so the Engine's invite-set readers can decode historical
// entries still sitting in Redis.
type HelperMatch struct {
	HelperID       string  `json:"helper_id"`
	DistanceKm     float64 `json:"distance_km"`
	Rating         float64 `json:"rating"`
	TotalJobs      int     `json:"total_jobs"`
	ActiveBookings int     `json:"active_bookings"`
	Score          float64 `json:"score"`
	WalkingMinutes int     `json:"walking_minutes,omitempty"` // from Google Maps; 0 if unavailable
}

// DemandCell is one entry in the demand heatmap response.
type DemandCell struct {
	CellID   string  `json:"cell_id"`
	Count    float64 `json:"count"`
	CenterLat float64 `json:"center_lat"`
	CenterLng float64 `json:"center_lng"`
}
