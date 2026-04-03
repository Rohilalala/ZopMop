package booking

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository handles all database operations for the booking module.
// All queries are parameterized. Every query uses a 5s context timeout.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new booking repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// CreateBooking inserts a new booking record.
func (r *Repository) CreateBooking(ctx context.Context, b *Booking) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	err := r.db.QueryRow(queryCtx,
		`INSERT INTO bookings (customer_id, service_category_id, status, address, lat, lng, price_cents, promo_code, discount_cents)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id, created_at, updated_at`,
		b.CustomerID, b.ServiceCategoryID, StatusPending, b.Address,
		b.Lat, b.Lng, b.PriceCents, b.PromoCode, b.DiscountCents,
	).Scan(&b.ID, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create booking: %w", err)
	}

	b.Status = StatusPending
	return nil
}

// GetBookingByID retrieves a booking by ID.
// Includes IDOR check: returns error if the booking doesn't belong to the requesting user
// (unless the user is a helper assigned to it or an admin).
func (r *Repository) GetBookingByID(ctx context.Context, bookingID, requestingUserID string) (*Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	b := &Booking{}
	err := r.db.QueryRow(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, price_cents, promo_code, discount_cents, created_at, updated_at
		 FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(
		&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID, &b.Status,
		&b.Address, &b.Lat, &b.Lng, &b.PriceCents, &b.PromoCode,
		&b.DiscountCents, &b.CreatedAt, &b.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("booking not found")
		}
		return nil, fmt.Errorf("failed to get booking: %w", err)
	}

	// IDOR check: ensure the requesting user owns this booking or is the assigned helper.
	if b.CustomerID != requestingUserID {
		if b.HelperID == nil || *b.HelperID != requestingUserID {
			return nil, fmt.Errorf("booking not found") // Intentionally vague to prevent enumeration.
		}
	}

	return b, nil
}

// GetPendingBookingByID retrieves a pending booking by ID without IDOR checks.
// This is specifically for helpers accepting pending bookings where helper_id is NULL.
// Only returns bookings that are in pending status.
func (r *Repository) GetPendingBookingByID(ctx context.Context, bookingID string) (*Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	b := &Booking{}
	err := r.db.QueryRow(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, price_cents, promo_code, discount_cents, created_at, updated_at
		 FROM bookings WHERE id = $1 AND status = $2`,
		bookingID, StatusPending,
	).Scan(
		&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID, &b.Status,
		&b.Address, &b.Lat, &b.Lng, &b.PriceCents, &b.PromoCode,
		&b.DiscountCents, &b.CreatedAt, &b.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("booking not found or not in pending status")
		}
		return nil, fmt.Errorf("failed to get booking: %w", err)
	}
	return b, nil
}

// UpdateBookingStatus updates the status of a booking.
// It validates that the status transition is allowed.
func (r *Repository) UpdateBookingStatus(ctx context.Context, bookingID string, newStatus BookingStatus) error {
	// Fetch current booking to validate state transition.
	b, err := r.getBookingByID(ctx, bookingID)
	if err != nil {
		return err
	}

	if !isValidTransition(b.Status, newStatus) {
		return fmt.Errorf("invalid status transition from %s to %s", b.Status, newStatus)
	}

	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1`,
		bookingID, newStatus,
	)
	if err != nil {
		return fmt.Errorf("failed to update booking status: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("booking not found")
	}

	return nil
}

// isValidTransition checks if a booking status transition is valid.
func isValidTransition(from, to BookingStatus) bool {
	validTransitions := map[BookingStatus][]BookingStatus{
		StatusPending:    {StatusAccepted, StatusCancelled},
		StatusAccepted:   {StatusInProgress, StatusCancelled},
		StatusInProgress: {StatusCompleted, StatusCancelled},
		StatusCompleted:  {}, // terminal state
		StatusCancelled:  {}, // terminal state
	}

	allowed, ok := validTransitions[from]
	if !ok {
		return false
	}
	for _, s := range allowed {
		if s == to {
			return true
		}
	}
	return false
}

// AcceptBooking assigns a helper to a pending booking and sets status to accepted.
func (r *Repository) AcceptBooking(ctx context.Context, bookingID, helperID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE bookings SET helper_id = $2, status = $3, updated_at = now() WHERE id = $1 AND status = $4`,
		bookingID, helperID, StatusAccepted, StatusPending,
	)
	if err != nil {
		return fmt.Errorf("failed to accept booking: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("booking not found or not in pending status")
	}

	return nil
}

// getBookingByID is an internal helper that bypasses IDOR check.
func (r *Repository) getBookingByID(ctx context.Context, bookingID string) (*Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	b := &Booking{}
	err := r.db.QueryRow(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, price_cents, promo_code, discount_cents, created_at, updated_at
		 FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(
		&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID, &b.Status,
		&b.Address, &b.Lat, &b.Lng, &b.PriceCents, &b.PromoCode,
		&b.DiscountCents, &b.CreatedAt, &b.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("booking not found")
		}
		return nil, fmt.Errorf("failed to get booking: %w", err)
	}
	return b, nil
}

// GetActiveBookingsCount returns the number of active bookings for a customer.
func (r *Repository) GetActiveBookingsCount(ctx context.Context, customerID string) (int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var count int
	err := r.db.QueryRow(queryCtx,
		`SELECT COUNT(*) FROM bookings
		 WHERE customer_id = $1 AND status IN ('pending', 'accepted', 'in_progress')`,
		customerID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count active bookings: %w", err)
	}

	return count, nil
}

// GetActiveBookingsCountForHelper returns the number of active bookings assigned to a helper.
func (r *Repository) GetActiveBookingsCountForHelper(ctx context.Context, helperID string) (int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var count int
	err := r.db.QueryRow(queryCtx,
		`SELECT COUNT(*) FROM bookings
		 WHERE helper_id = $1 AND status IN ('pending', 'accepted', 'in_progress')`,
		helperID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count helper active bookings: %w", err)
	}

	return count, nil
}

// GetCustomerBookings returns bookings for a specific customer with pagination.
func (r *Repository) GetCustomerBookings(ctx context.Context, customerID string, page, limit int) ([]Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	rows, err := r.db.Query(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, price_cents, promo_code, discount_cents, created_at, updated_at
		 FROM bookings WHERE customer_id = $1
		 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
		customerID, limit, offset,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query customer bookings: %w", err)
	}
	defer rows.Close()

	var bookings []Booking
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID,
			&b.Status, &b.Address, &b.Lat, &b.Lng, &b.PriceCents,
			&b.PromoCode, &b.DiscountCents, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan booking: %w", err)
		}
		bookings = append(bookings, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating bookings: %w", err)
	}

	return bookings, nil
}

// IncrementPromoCodeUsage atomically increments the usage count of a promo code
// and checks the limit wasn't exceeded. Uses FOR UPDATE lock to prevent race conditions.
// Returns error if usage limit has been reached.
func (r *Repository) IncrementPromoCodeUsage(ctx context.Context, promoCode string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Use a transaction with FOR UPDATE lock for atomicity.
	tx, err := r.db.Begin(queryCtx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(queryCtx)

	// Lock and fetch current usage.
	var usesCount, maxUses int
	err = tx.QueryRow(queryCtx,
		`SELECT uses_count, max_uses FROM promotions WHERE code = $1 FOR UPDATE`,
		promoCode,
	).Scan(&usesCount, &maxUses)
	if err != nil {
		if err == pgx.ErrNoRows {
			return fmt.Errorf("promo code not found")
		}
		return fmt.Errorf("failed to fetch promo code: %w", err)
	}

	// Check if limit would be exceeded.
	if maxUses > 0 && usesCount >= maxUses {
		return fmt.Errorf("promo code usage limit already reached")
	}

	// Increment usage count.
	result, err := tx.Exec(queryCtx,
		`UPDATE promotions SET uses_count = uses_count + 1 WHERE code = $1`,
		promoCode,
	)
	if err != nil {
		return fmt.Errorf("failed to increment promo usage: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("promo code not found")
	}

	if err := tx.Commit(queryCtx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}
