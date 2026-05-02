package booking

import (
	"context"
	"encoding/json"
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
// cancelledBy is only used when newStatus == StatusCancelled; pass "" otherwise.
// It validates that the status transition is allowed.
func (r *Repository) UpdateBookingStatus(ctx context.Context, bookingID string, newStatus BookingStatus, cancelledBy string) error {
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

	var query string
	var args []any
	if newStatus == StatusCancelled {
		query = `UPDATE bookings SET status = $2, updated_at = now(), cancelled_at = NOW(), cancelled_by = $3 WHERE id = $1`
		args = []any{bookingID, newStatus, cancelledBy}
	} else {
		query = `UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1`
		args = []any{bookingID, newStatus}
	}

	result, err := r.db.Exec(queryCtx, query, args...)
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

// MarkArrived stamps arrived_at = NOW() iff the booking is currently accepted
// and the requesting helper is the one assigned. Returns the new arrived_at
// timestamp on success.
func (r *Repository) MarkArrived(ctx context.Context, bookingID, helperID string) (time.Time, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var t time.Time
	err := r.db.QueryRow(queryCtx,
		`UPDATE bookings
		    SET arrived_at = NOW(), updated_at = NOW()
		  WHERE id = $1
		    AND helper_id = $2
		    AND status = $3
		  RETURNING arrived_at`,
		bookingID, helperID, StatusAccepted,
	).Scan(&t)
	if err != nil {
		if err == pgx.ErrNoRows {
			return time.Time{}, fmt.Errorf("booking not in accepted state for this helper")
		}
		return time.Time{}, fmt.Errorf("failed to mark arrived: %w", err)
	}
	return t, nil
}

// IsBookingArrived returns true if arrived_at has been stamped.
func (r *Repository) IsBookingArrived(ctx context.Context, bookingID string) (bool, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var arrivedAt *time.Time
	err := r.db.QueryRow(queryCtx,
		`SELECT arrived_at FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(&arrivedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return false, fmt.Errorf("booking not found")
		}
		return false, fmt.Errorf("failed to read arrived_at: %w", err)
	}
	return arrivedAt != nil, nil
}

// AcceptBooking assigns a helper to a pending booking and sets status to accepted.
func (r *Repository) AcceptBooking(ctx context.Context, bookingID, helperID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE bookings SET helper_id = $2, status = $3, updated_at = now(), accepted_at = NOW() WHERE id = $1 AND status = $4`,
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
		 WHERE customer_id = $1 AND status IN ('accepted', 'in_progress')`,
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
		 WHERE helper_id = $1 AND status IN ('accepted', 'in_progress')`,
		helperID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count helper active bookings: %w", err)
	}

	return count, nil
}

// GetHelperActiveBookings returns bookings assigned to this helper that are
// currently accepted or in_progress (instant or scheduled). Newest first.
func (r *Repository) GetHelperActiveBookings(ctx context.Context, helperID string) ([]Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, price_cents, promo_code, discount_cents, created_at, updated_at
		 FROM bookings
		 WHERE helper_id = $1 AND status IN ('accepted', 'in_progress')
		 ORDER BY updated_at DESC`,
		helperID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query helper active bookings: %w", err)
	}
	defer rows.Close()

	bookings := make([]Booking, 0)
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID,
			&b.Status, &b.Address, &b.Lat, &b.Lng, &b.PriceCents,
			&b.PromoCode, &b.DiscountCents, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan helper active booking: %w", err)
		}
		bookings = append(bookings, b)
	}
	return bookings, rows.Err()
}

// GetHelperBookingsToday returns all bookings the helper touched today —
// active (accepted/in_progress) plus those completed/cancelled today. Used to
// show "today's work" on the pro dashboard so a pro who restarts the app
// mid-day still sees their progress.
func (r *Repository) GetHelperBookingsToday(ctx context.Context, helperID string) ([]Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, price_cents, promo_code, discount_cents, created_at, updated_at
		 FROM bookings
		 WHERE helper_id = $1
		   AND (
		     status IN ('accepted', 'in_progress')
		     OR (status IN ('completed', 'cancelled') AND updated_at::date = CURRENT_DATE)
		   )
		 ORDER BY
		   CASE status
		     WHEN 'in_progress' THEN 0
		     WHEN 'accepted'    THEN 1
		     WHEN 'completed'   THEN 2
		     WHEN 'cancelled'   THEN 3
		     ELSE 4
		   END,
		   updated_at DESC`,
		helperID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query helper today bookings: %w", err)
	}
	defer rows.Close()

	bookings := make([]Booking, 0)
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID,
			&b.Status, &b.Address, &b.Lat, &b.Lng, &b.PriceCents,
			&b.PromoCode, &b.DiscountCents, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan helper today booking: %w", err)
		}
		bookings = append(bookings, b)
	}
	return bookings, rows.Err()
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

// CreateScheduledBooking creates a booking from cart items using the new scheduling flow.
// It inserts the booking row, booking_services rows, and returns the full ScheduledBooking.
// The caller must have already validated the cart, time slot, and address.
func (r *Repository) CreateScheduledBooking(
	ctx context.Context,
	customerID, addressID, timeSlotID string,
	scheduledTime string,
	items []BookingServiceItem,
	totalPriceCents, discountCents int,
	promoCode *string,
) (*ScheduledBooking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.db.Begin(queryCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(queryCtx)

	// Calculate total duration.
	totalDuration := 0
	for _, item := range items {
		totalDuration += item.DurationMinutes
	}

	// Use a placeholder service_category_id (first item) for the legacy column.
	legacyServiceID := items[0].ServiceID

	var b ScheduledBooking
	err = tx.QueryRow(queryCtx,
		`INSERT INTO bookings
		   (customer_id, service_category_id, status, address, lat, lng,
		    price_cents, discount_cents, promo_code,
		    address_id, time_slot_id, scheduled_time, total_duration_minutes)
		 VALUES ($1, $2, $3, '', 0, 0, $4, $5, $6, $7, $8, $9, $10)
		 RETURNING id, customer_id, address_id, time_slot_id,
		           to_char(scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		           total_duration_minutes, status, price_cents, discount_cents, promo_code, created_at`,
		customerID, legacyServiceID, StatusPending,
		totalPriceCents, discountCents, promoCode,
		addressID, timeSlotID, scheduledTime, totalDuration,
	).Scan(
		&b.ID, &b.CustomerID, &b.AddressID, &b.TimeSlotID, &b.ScheduledTime,
		&b.TotalDurationMinutes, &b.Status, &b.PriceCents, &b.DiscountCents,
		&b.PromoCode, &b.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create scheduled booking: %w", err)
	}

	// Insert booking_services rows.
	for _, item := range items {
		_, err := tx.Exec(queryCtx,
			`INSERT INTO booking_services (booking_id, service_id, duration_minutes, price_cents)
			 VALUES ($1, $2, $3, $4)`,
			b.ID, item.ServiceID, item.DurationMinutes, item.PriceCents,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to insert booking service: %w", err)
		}
	}

	if err := tx.Commit(queryCtx); err != nil {
		return nil, fmt.Errorf("failed to commit scheduled booking: %w", err)
	}

	b.Services = items
	return &b, nil
}

// GetCustomerBookingsByStatus returns bookings for a customer filtered by status group.
// status param: "upcoming" → pending/accepted/in_progress, "past" → completed/cancelled.
func (r *Repository) GetCustomerBookingsByStatus(ctx context.Context, customerID, status string, page, limit int) ([]ScheduledBooking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	var statusFilter string
	switch status {
	case "upcoming":
		statusFilter = `status IN ('pending', 'accepted', 'in_progress')`
	case "past":
		statusFilter = `status IN ('completed', 'cancelled')`
	default:
		statusFilter = `true`
	}

	rows, err := r.db.Query(queryCtx, `
		SELECT
			b.id, b.customer_id, b.address_id, b.time_slot_id,
			to_char(b.scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS scheduled_time,
			b.total_duration_minutes, b.status, b.price_cents, b.discount_cents, b.promo_code, b.created_at,
			COALESCE(
				json_agg(
					json_build_object(
						'service_id', bs.service_id::text,
						'service_name', sc.name,
						'duration_minutes', bs.duration_minutes,
						'price_cents', bs.price_cents
					)
					ORDER BY bs.id
				) FILTER (WHERE bs.service_id IS NOT NULL),
				'[]'::json
			) AS services
		FROM bookings b
		LEFT JOIN booking_services bs ON bs.booking_id = b.id
		LEFT JOIN service_categories sc ON sc.id = bs.service_id
		WHERE b.customer_id = $1
		  AND `+statusFilter+`
		GROUP BY b.id, b.customer_id, b.address_id, b.time_slot_id, b.scheduled_time,
		         b.total_duration_minutes, b.status, b.price_cents, b.discount_cents, b.promo_code, b.created_at
		ORDER BY COALESCE(b.scheduled_time, b.created_at) DESC
		LIMIT $2 OFFSET $3`,
		customerID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("failed to query bookings: %w", err)
	}
	defer rows.Close()

	var bookings []ScheduledBooking
	for rows.Next() {
		var b ScheduledBooking
		var servicesJSON []byte
		if err := rows.Scan(
			&b.ID, &b.CustomerID, &b.AddressID, &b.TimeSlotID, &b.ScheduledTime,
			&b.TotalDurationMinutes, &b.Status, &b.PriceCents, &b.DiscountCents,
			&b.PromoCode, &b.CreatedAt, &servicesJSON,
		); err != nil {
			return nil, fmt.Errorf("failed to scan booking: %w", err)
		}
		if err := json.Unmarshal(servicesJSON, &b.Services); err != nil {
			return nil, fmt.Errorf("failed to decode booking services: %w", err)
		}
		bookings = append(bookings, b)
	}
	if bookings == nil {
		bookings = []ScheduledBooking{}
	}
	return bookings, rows.Err()
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
