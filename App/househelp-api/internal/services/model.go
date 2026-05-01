package services

import "time"

// Service is a service category with full display metadata.
type Service struct {
	ID                  string    `json:"id"`
	Name                string    `json:"name"`
	Description         *string   `json:"description,omitempty"`
	ShortDescription    *string   `json:"short_description,omitempty"`
	Emoji               *string   `json:"emoji"`
	BgColor             string    `json:"bg_color"`
	BasePriceCents      int       `json:"base_price_cents"`
	MrpCents            *int      `json:"mrp_cents,omitempty"`
	Rating              float64   `json:"rating"`
	ReviewCount         int       `json:"review_count"`
	MinDurationMinutes  int       `json:"min_duration_minutes"`
	MaxDurationMinutes  int       `json:"max_duration_minutes"`
	DurationStepMinutes int       `json:"duration_step_minutes"`
	IsActive            bool      `json:"is_active"`
	DisplayOrder        int       `json:"display_order"`
	Category            string    `json:"category"`
	CreatedAt           time.Time `json:"created_at"`
}

// ServiceInclude is a single "what's included" item.
type ServiceInclude struct {
	ID           string `json:"id"`
	Item         string `json:"item"`
	DisplayOrder int    `json:"display_order"`
}

// ServiceExclude is a single "what's excluded" item.
type ServiceExclude struct {
	ID           string `json:"id"`
	Item         string `json:"item"`
	DisplayOrder int    `json:"display_order"`
}

// ServiceStep is one step in the "how it works" flow.
type ServiceStep struct {
	ID          string  `json:"id"`
	StepNumber  int     `json:"step_number"`
	Title       string  `json:"title"`
	Description *string `json:"description,omitempty"`
	Icon        *string `json:"icon,omitempty"`
}

// ServiceAddon is a related service that can be added on.
type ServiceAddon struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Emoji         *string `json:"emoji,omitempty"`
	BgColor       string  `json:"bg_color"`
	BasePriceCents int    `json:"base_price_cents"`
	DisplayOrder  int     `json:"display_order"`
}

// ServiceDetails is the combined response for GET /services/:id/details.
type ServiceDetails struct {
	Service  *Service         `json:"service"`
	Includes []ServiceInclude `json:"includes"`
	Excludes []ServiceExclude `json:"excludes"`
	Steps    []ServiceStep    `json:"steps"`
}

// AdminUpdateServiceRequest is the payload for PATCH /admin/services/:id.
// All fields are optional — only non-zero/non-nil values are applied.
type AdminUpdateServiceRequest struct {
	Name           string  `json:"name,omitempty" validate:"omitempty,min=1,max=200"`
	BasePriceCents *int    `json:"base_price_cents,omitempty" validate:"omitempty,gt=0"`
	IsActive       *bool   `json:"is_active,omitempty"`
	DisplayOrder   *int    `json:"display_order,omitempty"`
	Emoji          *string `json:"emoji,omitempty"`
	BgColor        string  `json:"bg_color,omitempty"`
	Category       string  `json:"category,omitempty"`
}

// AdminCreateServiceRequest is the payload for POST /admin/services.
type AdminCreateServiceRequest struct {
	Name                string `json:"name" validate:"required,min=1,max=200"`
	Emoji               string `json:"emoji,omitempty"`
	BgColor             string `json:"bg_color,omitempty"`
	BasePriceCents      int    `json:"base_price_cents" validate:"required,gt=0"`
	DisplayOrder        int    `json:"display_order"`
	Category            string `json:"category,omitempty"`
	MinDurationMinutes  int    `json:"min_duration_minutes,omitempty"`
	MaxDurationMinutes  int    `json:"max_duration_minutes,omitempty"`
	DurationStepMinutes int    `json:"duration_step_minutes,omitempty"`
}
