package location

// LocationUpdate represents a real-time location update from a helper.
type LocationUpdate struct {
	HelperID string  `json:"helper_id"`
	Lat      float64 `json:"lat" validate:"required,latitude"`
	Lng      float64 `json:"lng" validate:"required,longitude"`
}

// LocationResponse is returned when querying a helper's current location.
type LocationResponse struct {
	HelperID string  `json:"helper_id"`
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
}
