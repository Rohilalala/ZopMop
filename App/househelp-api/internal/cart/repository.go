package cart

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository handles all database operations for the cart module.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new cart repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// GetOrCreateCart returns the user's cart (creating one if it doesn't exist).
func (r *Repository) GetOrCreateCart(ctx context.Context, userID string) (*Cart, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var c Cart
	err := r.db.QueryRow(ctx,
		`INSERT INTO cart (user_id) VALUES ($1)
		 ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
		 RETURNING id, user_id, created_at, updated_at`,
		userID,
	).Scan(&c.ID, &c.UserID, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to get or create cart: %w", err)
	}

	items, err := r.listItems(ctx, c.ID)
	if err != nil {
		return nil, err
	}
	c.Items = items
	return &c, nil
}

// AddItem upserts a service into the cart. If the service is already in the
// cart the duration and price are updated.
func (r *Repository) AddItem(ctx context.Context, cartID, serviceID string, durationMinutes, priceCents int) (*CartItem, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var item CartItem
	// ON CONFLICT WHERE matches the partial unique index added in
	// migration 096 (idx_cart_items_unique_service_only). Migration 095
	// dropped the legacy (cart_id, service_id) UNIQUE; the new partial
	// index only covers rows where neither variant_id nor bundle_id is
	// set, which is the path the current customer mobile build uses.
	// When variant-aware writes ship, they must use the matching
	// (cart_id, variant_id) / (cart_id, bundle_id) partial indexes.
	err := r.db.QueryRow(ctx,
		`INSERT INTO cart_items (cart_id, service_id, duration_minutes, price_cents)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (cart_id, service_id)
		   WHERE variant_id IS NULL AND bundle_id IS NULL
		 DO UPDATE
		   SET duration_minutes = EXCLUDED.duration_minutes,
		       price_cents      = EXCLUDED.price_cents
		 RETURNING id, cart_id, service_id, duration_minutes, price_cents`,
		cartID, serviceID, durationMinutes, priceCents,
	).Scan(&item.ID, &item.CartID, &item.ServiceID, &item.DurationMinutes, &item.PriceCents)
	if err != nil {
		return nil, fmt.Errorf("failed to add cart item: %w", err)
	}

	// Enrich with service metadata.
	_ = r.db.QueryRow(ctx,
		`SELECT name, emoji FROM service_categories WHERE id = $1`, serviceID,
	).Scan(&item.ServiceName, &item.ServiceEmoji)

	return &item, nil
}

// RemoveItem removes a cart item by item ID, scoped to the cart owner.
func (r *Repository) RemoveItem(ctx context.Context, cartID, itemID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(ctx,
		`DELETE FROM cart_items WHERE id = $1 AND cart_id = $2`,
		itemID, cartID,
	)
	if err != nil {
		return fmt.Errorf("failed to remove cart item: %w", err)
	}
	if result.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// ClearCart removes all items from a user's cart.
func (r *Repository) ClearCart(ctx context.Context, cartID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := r.db.Exec(ctx, `DELETE FROM cart_items WHERE cart_id = $1`, cartID)
	return err
}

// listItems returns all items in a cart, enriched with service metadata.
func (r *Repository) listItems(ctx context.Context, cartID string) ([]CartItem, error) {
	rows, err := r.db.Query(ctx,
		`SELECT ci.id, ci.cart_id, ci.service_id, sc.name, sc.emoji,
		        ci.duration_minutes, ci.price_cents
		 FROM cart_items ci
		 JOIN service_categories sc ON sc.id = ci.service_id
		 WHERE ci.cart_id = $1
		 ORDER BY ci.created_at ASC`,
		cartID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list cart items: %w", err)
	}
	defer rows.Close()

	var items []CartItem
	for rows.Next() {
		var item CartItem
		if err := rows.Scan(
			&item.ID, &item.CartID, &item.ServiceID, &item.ServiceName,
			&item.ServiceEmoji, &item.DurationMinutes, &item.PriceCents,
		); err != nil {
			return nil, fmt.Errorf("failed to scan cart item: %w", err)
		}
		items = append(items, item)
	}
	if items == nil {
		items = []CartItem{}
	}
	return items, rows.Err()
}

// GetCartByUserID returns the cart and items for a user without creating one.
func (r *Repository) GetCartByUserID(ctx context.Context, userID string) (*Cart, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var c Cart
	err := r.db.QueryRow(ctx,
		`SELECT id, user_id, created_at, updated_at FROM cart WHERE user_id = $1`,
		userID,
	).Scan(&c.ID, &c.UserID, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return &Cart{UserID: userID, Items: []CartItem{}}, nil
		}
		return nil, fmt.Errorf("failed to get cart: %w", err)
	}

	items, err := r.listItems(ctx, c.ID)
	if err != nil {
		return nil, err
	}
	c.Items = items
	return &c, nil
}

// GetServicePrice returns the base price for a service (used to calculate cart item price).
func (r *Repository) GetServicePrice(ctx context.Context, serviceID string, durationMinutes int) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var basePriceCents, minDuration int
	err := r.db.QueryRow(ctx,
		`SELECT base_price_cents, min_duration_minutes FROM service_categories WHERE id = $1`,
		serviceID,
	).Scan(&basePriceCents, &minDuration)
	if err != nil {
		if err == pgx.ErrNoRows {
			return 0, fmt.Errorf("service not found")
		}
		return 0, fmt.Errorf("failed to get service price: %w", err)
	}

	// Price scales linearly with duration relative to minimum duration.
	if minDuration <= 0 {
		minDuration = 30
	}
	priceCents := basePriceCents * durationMinutes / minDuration
	return priceCents, nil
}
