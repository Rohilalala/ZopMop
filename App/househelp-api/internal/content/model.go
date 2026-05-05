package content

import (
	"encoding/json"
	"time"
)

// Banner represents a promotional banner shown in the app.
type Banner struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Subtitle     string    `json:"subtitle,omitempty"`
	ImageURL     string    `json:"image_url"`
	TapAction    string    `json:"tap_action,omitempty"` // Deeplink.
	DisplayOrder int       `json:"display_order"`
	IsActive     bool      `json:"is_active"`
	StartsAt     *time.Time `json:"starts_at,omitempty"`
	EndsAt       *time.Time `json:"ends_at,omitempty"`
	CreatedBy    string    `json:"created_by"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// ServiceCategory represents a type of service offered.
type ServiceCategory struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Description   string    `json:"description,omitempty"`
	IconURL       string    `json:"icon_url,omitempty"`
	BasePriceCents int      `json:"base_price_cents"`
	IsActive      bool      `json:"is_active"`
	DisplayOrder  int       `json:"display_order"`
	CreatedBy     string    `json:"created_by"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// AppScreen represents dynamic screen content managed by admins.
// The Content JSONB shape: {"hero_title": "", "hero_subtitle": "", "cta_text": "",
//   "empty_state_text": "", "sections": []}
type AppScreen struct {
	ID        string          `json:"id"`
	ScreenKey string          `json:"screen_key"` // Unique key like "home", "booking_confirm".
	Content   json.RawMessage `json:"content"`    // JSONB.
	IsActive  bool            `json:"is_active"`
	UpdatedBy string          `json:"updated_by"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// FAQItem represents a frequently asked question.
type FAQItem struct {
	ID           string `json:"id"`
	Question     string `json:"question"`
	Answer       string `json:"answer"`
	Category     string `json:"category"`
	DisplayOrder int    `json:"display_order"`
	IsActive     bool   `json:"is_active"`
}

// HomeContentResponse is the combined response for the app home screen.
type HomeContentResponse struct {
	Banners           []Banner          `json:"banners"`
	ServiceCategories []ServiceCategory `json:"service_categories"`
	Screen            json.RawMessage   `json:"screen"`
}

// CreateBannerRequest is the input for creating/updating a banner.
type CreateBannerRequest struct {
	Title        string     `json:"title" validate:"required,max=200"`
	Subtitle     string     `json:"subtitle,omitempty" validate:"max=500"`
	ImageURL     string     `json:"image_url" validate:"required,url"`
	TapAction    string     `json:"tap_action,omitempty" validate:"omitempty,max=500"`
	DisplayOrder int        `json:"display_order"`
	IsActive     bool       `json:"is_active"`
	StartsAt     *time.Time `json:"starts_at,omitempty"`
	EndsAt       *time.Time `json:"ends_at,omitempty"`
}

// CreateServiceCategoryRequest is the input for creating/updating a service category.
type CreateServiceCategoryRequest struct {
	Name           string `json:"name" validate:"required,max=100"`
	Description    string `json:"description,omitempty" validate:"omitempty,max=2000"`
	IconURL        string `json:"icon_url,omitempty" validate:"omitempty,max=500"`
	BasePriceCents int    `json:"base_price_cents" validate:"required,min=0"`
	IsActive       bool   `json:"is_active"`
	DisplayOrder   int    `json:"display_order"`
}

// UpdateScreenContentRequest is the input for updating screen content. The
// JSON blob is parsed downstream by the SDUI resolver; cap raw size at 100KB
// so a malicious admin can't fill the table with megabyte payloads.
type UpdateScreenContentRequest struct {
	Content json.RawMessage `json:"content" validate:"required,max=100000"`
}
