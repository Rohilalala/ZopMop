package zones

import "time"

// ServiceZone is an operational area defined by a lat/lon point and radius.
type ServiceZone struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	City      string    `json:"city"`
	Lat       float64   `json:"lat"`
	Lon       float64   `json:"lon"`
	RadiusKm  float64   `json:"radius_km"`
	IsActive  bool      `json:"is_active"`
	CreatedAt time.Time `json:"created_at"`
}

// CheckResponse is returned by GET /zones/check.
type CheckResponse struct {
	Serviceable bool   `json:"serviceable"`
	ZoneName    string `json:"zone_name,omitempty"`
	City        string `json:"city,omitempty"`
}
