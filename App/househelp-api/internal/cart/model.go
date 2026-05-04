package cart

import "time"

// Cart is a user's active cart.
type Cart struct {
	ID        string     `json:"id"`
	UserID    string     `json:"user_id"`
	Items     []CartItem `json:"items"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// CartItem is a single service entry in the cart.
type CartItem struct {
	ID              string  `json:"id"`
	CartID          string  `json:"cart_id"`
	ServiceID       string  `json:"service_id"`
	ServiceName     string  `json:"service_name"`
	ServiceEmoji    *string `json:"service_emoji,omitempty"`
	DurationMinutes int     `json:"duration_minutes"`
	PriceCents      int     `json:"price_cents"`
}

// AddItemRequest is the body for POST /cart/add.
type AddItemRequest struct {
	ServiceID       string `json:"service_id"       validate:"required,uuid_format"`
	DurationMinutes int    `json:"duration_minutes" validate:"required,min=1,max=480"`
}

// UpdateItemRequest is the body for PUT /cart/items/:id.
type UpdateItemRequest struct {
	DurationMinutes int `json:"duration_minutes" validate:"required,min=30,max=90"`
}
