package matching

// HelperMatch represents a matched helper for a booking request.
type HelperMatch struct {
	HelperID   string  `json:"helper_id"`
	DistanceKm float64 `json:"distance_km"`
	Rating     float64 `json:"rating"`
	TotalJobs  int     `json:"total_jobs"`
}

// MatchRequest represents a request to find helpers.
type MatchRequest struct {
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	RadiusKm float64 `json:"radius_km"`
}
