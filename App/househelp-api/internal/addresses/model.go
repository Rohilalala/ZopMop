package addresses

import "time"

// Address is a saved service/delivery address belonging to a customer.
type Address struct {
	ID            string    `json:"id"`
	UserID        string    `json:"user_id"`
	Tag           string    `json:"tag"`
	Title         string    `json:"title"`
	FlatNo        string    `json:"flat_no"`
	Floor         string    `json:"floor,omitempty"`
	BuildingName  string    `json:"building_name"`
	Landmark      string    `json:"landmark,omitempty"`
	FullAddress   string    `json:"full_address"`
	ReceiverName  string    `json:"receiver_name,omitempty"`
	ReceiverPhone string    `json:"receiver_phone,omitempty"`
	Lat           float64   `json:"lat"`
	Lon           float64   `json:"lon"`
	CreatedAt     time.Time `json:"created_at"`
}

// UpdateAddressRequest is the request body for PUT /addresses/:id.
// All fields are optional — only non-empty values are applied.
type UpdateAddressRequest struct {
	Tag           string  `json:"tag"            validate:"omitempty,oneof=Home Work Other"`
	Title         string  `json:"title"          validate:"omitempty,max=100"`
	FlatNo        string  `json:"flat_no"        validate:"omitempty,max=50"`
	Floor         string  `json:"floor"          validate:"max=50"`
	BuildingName  string  `json:"building_name"  validate:"omitempty,max=100"`
	Landmark      string  `json:"landmark"       validate:"max=100"`
	FullAddress   string  `json:"full_address"   validate:"omitempty,max=1000"`
	ReceiverName  string  `json:"receiver_name"  validate:"max=100"`
	ReceiverPhone string  `json:"receiver_phone" validate:"max=20"`
	Lat           float64 `json:"lat"            validate:"omitempty,latitude"`
	Lon           float64 `json:"lon"            validate:"omitempty,longitude"`
}

// CreateAddressRequest is the request body for POST /addresses.
type CreateAddressRequest struct {
	Tag           string  `json:"tag"            validate:"required,oneof=Home Work Other"`
	Title         string  `json:"title"          validate:"required,max=100"`
	FlatNo        string  `json:"flat_no"        validate:"required,max=50"`
	Floor         string  `json:"floor"          validate:"max=50"`
	BuildingName  string  `json:"building_name"  validate:"required,max=100"`
	Landmark      string  `json:"landmark"       validate:"max=100"`
	FullAddress   string  `json:"full_address"   validate:"required,max=1000"`
	ReceiverName  string  `json:"receiver_name"  validate:"max=100"`
	ReceiverPhone string  `json:"receiver_phone" validate:"max=20"`
	Lat           float64 `json:"lat"            validate:"required,latitude"`
	Lon           float64 `json:"lon"            validate:"required,longitude"`
}
