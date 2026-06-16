package booking

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/wallet"
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
		`INSERT INTO bookings (customer_id, service_category_id, status, address, lat, lng, amount_paise, promo_code, discount_paise)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id, created_at, updated_at`,
		b.CustomerID, b.ServiceCategoryID, StatusPending, b.Address,
		b.Lat, b.Lng, b.AmountPaise, b.PromoCode, b.DiscountPaise,
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
		        lat, lng, amount_paise, promo_code, discount_paise,
		        scheduled_time, cancelled_at, cancelled_by, cancellation_fee_applied, cancellation_fee_cents,
		        accepted_at, en_route_at, arrived_at, started_at, completed_at,
		        pro_earnings_paise, actual_duration_minutes, customer_rating_pending,
		        created_at, updated_at
		 FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(
		&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID, &b.Status,
		&b.Address, &b.Lat, &b.Lng, &b.AmountPaise, &b.PromoCode,
		&b.DiscountPaise,
		&b.ScheduledTime, &b.CancelledAt, &b.CancelledBy, &b.CancellationFeeApplied, &b.CancellationFeeCents,
		&b.AcceptedAt, &b.EnRouteAt, &b.ArrivedAt, &b.StartedAt, &b.CompletedAt,
		&b.ProEarningsPaise, &b.ActualDurationMinutes, &b.CustomerRatingPending,
		&b.CreatedAt, &b.UpdatedAt,
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

// GetBookingDetailHelper loads the assigned pro's customer-facing slice.
// Returns nil with no error when the booking has no helper assigned.
// Phone masking is the caller's responsibility — this returns the raw value.
func (r *Repository) GetBookingDetailHelper(ctx context.Context, helperID string) (*BookingDetailHelper, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	h := &BookingDetailHelper{}
	err := r.db.QueryRow(queryCtx,
		`SELECT u.id::text, COALESCE(u.name,''), COALESCE(u.phone,''),
		        COALESCE(hp.rating, 5.0), COALESCE(hp.total_jobs, 0),
		        COALESCE(u.avatar_url, '')
		 FROM users u
		 JOIN helpers hp ON hp.id = u.id
		 WHERE u.id = $1`,
		helperID,
	).Scan(&h.ID, &h.Name, &h.Phone, &h.Rating, &h.TotalJobs, &h.PhotoURL)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to fetch helper detail: %w", err)
	}
	return h, nil
}

// GetBookingDetailServices returns every booking_services row for the booking
// joined to its service_categories row for the display name. Ordered by
// display_order ascending — the canonical task checklist sequence.
func (r *Repository) GetBookingDetailServices(ctx context.Context, bookingID string) ([]BookingDetailService, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT bs.id::text, bs.service_id::text, COALESCE(sc.name, ''), bs.duration_minutes,
		        bs.price_paise, bs.quantity, bs.status, bs.display_order,
		        bs.started_at, bs.completed_at, bs.skip_reason
		 FROM booking_services bs
		 LEFT JOIN service_categories sc ON sc.id = bs.service_id
		 WHERE bs.booking_id = $1
		 ORDER BY bs.display_order ASC, bs.id ASC`,
		bookingID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query booking services: %w", err)
	}
	defer rows.Close()

	out := make([]BookingDetailService, 0)
	for rows.Next() {
		var s BookingDetailService
		if err := rows.Scan(&s.ID, &s.ServiceID, &s.ServiceName, &s.DurationMinutes,
			&s.PricePaise, &s.Quantity, &s.Status, &s.DisplayOrder,
			&s.StartedAt, &s.CompletedAt, &s.SkipReason); err != nil {
			return nil, fmt.Errorf("scan booking service: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// GetPendingBookingByID retrieves an acceptable (unassigned) booking by ID
// without IDOR checks. This is specifically for helpers accepting bookings
// where helper_id is NULL. Matches both a freshly-created 'pending' row and a
// stealth-instant row the StealthDispatcher already flipped to 'searching' —
// mirroring the status set AcceptBooking's UPDATE claims (see :437).
func (r *Repository) GetPendingBookingByID(ctx context.Context, bookingID string) (*Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	b := &Booking{}
	err := r.db.QueryRow(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, amount_paise, promo_code, discount_paise, created_at, updated_at
		 FROM bookings WHERE id = $1 AND status IN ($2, $3) AND helper_id IS NULL`,
		bookingID, StatusPending, StatusSearching,
	).Scan(
		&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID, &b.Status,
		&b.Address, &b.Lat, &b.Lng, &b.AmountPaise, &b.PromoCode,
		&b.DiscountPaise, &b.CreatedAt, &b.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			// Sentinel, not a fresh error: handler.go:470 / jobs.go:316 map
			// ErrBookingNotPending to 409 via errors.Is — a fresh fmt.Errorf
			// here surfaced every already-taken accept as a 500.
			return nil, ErrBookingNotPending
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

// CancelBookingWithFee transitions a booking to cancelled and atomically
// settles the cancellation fee + refund. cancelledBy is "customer" | "helper" |
// "system". feeCents is the *notional* fee (0 inside the free window).
//
// The fee is collected by withholding it from the refund, so it can never
// exceed what the customer actually paid: the effective fee is clamped to the
// net collected amount (and is 0 for unpaid / COD bookings, which have nothing
// to deduct). This stops the broken case where a flat fee larger than a small
// booking produced a negative refund — no refund row at all and a silent
// forfeit of the whole paid amount (and a phantom fee on an unpaid row).
//
// The refund (net paid − effective fee) is routed through the canonical
// wallet.RecordBookingRefundTx so wallet payments are instant-credited back to
// the wallet, Cashfree payments land on the pending_refunds queue, and
// cash/null methods move nothing — all in the same transaction as the status
// change. walletRepo may be nil (the fee=0 system/rollback callers never have
// a paid booking to refund); a nil repo means "no movement".
//
// Returns the effective (clamped) fee actually stamped on the row so callers
// can echo a truthful amount back to the user.
func (r *Repository) CancelBookingWithFee(ctx context.Context, bookingID, cancelledBy string, feeCents int, walletRepo *wallet.Repository) (int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := r.db.BeginTx(queryCtx, pgx.TxOptions{})
	if err != nil {
		return 0, fmt.Errorf("failed to begin cancel tx: %w", err)
	}
	defer tx.Rollback(context.Background())

	var (
		customerID    string
		helperID      *string
		priceCents    int64
		discountCents int64
		paymentMethod *string
		paymentID     *string
		paymentStatus *string
	)
	// First read the row (locking it) so we can compute the effective fee from
	// the amount actually collected before we stamp it.
	err = tx.QueryRow(queryCtx,
		`SELECT customer_id::text, amount_paise, COALESCE(discount_paise, 0),
		        payment_method, payment_id, payment_status, helper_id::text
		   FROM bookings
		  WHERE id = $1 AND status IN ('pending', 'accepted')
		  FOR UPDATE`,
		bookingID,
	).Scan(&customerID, &priceCents, &discountCents, &paymentMethod, &paymentID, &paymentStatus, &helperID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return 0, fmt.Errorf("booking cannot be cancelled in current status")
		}
		return 0, fmt.Errorf("failed to load booking for cancel: %w", err)
	}

	// The fee is only ever realised by withholding it from a refund, so it can
	// never exceed the net amount the customer actually paid. Unpaid / COD rows
	// have nothing collected → net paid is 0 → effective fee is 0 (no phantom
	// fee on a row the customer was never charged for).
	paid := paymentStatus != nil && *paymentStatus == "paid"
	netPaid := int64(0)
	if paid {
		netPaid = priceCents - discountCents
		if netPaid < 0 {
			netPaid = 0
		}
	}
	effectiveFee := int64(feeCents)
	if effectiveFee > netPaid {
		effectiveFee = netPaid
	}
	feeApplied := effectiveFee > 0

	if _, err := tx.Exec(queryCtx,
		`UPDATE bookings
		    SET status = $2, updated_at = NOW(), cancelled_at = NOW(),
		        cancelled_by = $3,
		        cancellation_fee_applied = $4, cancellation_fee_cents = $5
		  WHERE id = $1`,
		bookingID, StatusCancelled, cancelledBy, feeApplied, effectiveFee,
	); err != nil {
		return 0, fmt.Errorf("failed to cancel booking: %w", err)
	}

	// Refund the net paid amount minus the (clamped) fee through the canonical
	// router. RecordBookingRefundTx no-ops when unpaid or refund <= 0, and picks
	// the wallet-credit vs Cashfree-queue rail by payment_method.
	refundAmount := netPaid - effectiveFee
	if walletRepo != nil && refundAmount > 0 {
		if err := wallet.RecordBookingRefundTx(queryCtx, tx, walletRepo,
			customerID, bookingID, paymentMethod, paymentID, paymentStatus,
			refundAmount, "Booking cancellation refund"); err != nil {
			return 0, fmt.Errorf("failed to record cancellation refund: %w", err)
		}
	}

	// Emit booking.cancelled in the same tx so the notification fires even if
	// the process crashes after commit. Handler reads helper_id and fires FCM.
	if helperID != nil {
		if p, merr := json.Marshal(map[string]any{"booking_id": bookingID, "helper_id": *helperID}); merr == nil {
			_, _ = tx.Exec(queryCtx,
				`INSERT INTO event_outbox (event_type, aggregate_id, payload)
				 VALUES ('booking.cancelled', $1::uuid, $2::jsonb)`,
				bookingID, p)
		}
	}

	if err := tx.Commit(queryCtx); err != nil {
		return 0, fmt.Errorf("failed to commit cancel tx: %w", err)
	}
	return int(effectiveFee), nil
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

// ErrBookingNotPending is returned when AcceptBooking races against another
// helper that already accepted (or against a customer cancellation).
var ErrBookingNotPending = fmt.Errorf("booking not found or not in pending status")

// ErrAlreadyAccepted is the spec-named alias for the booking-side race loser.
// Same semantics as ErrBookingNotPending — kept distinct so call sites can
// surface a more user-friendly message.
var ErrAlreadyAccepted = fmt.Errorf("booking already accepted")

// ErrHelperAtMaxActive is returned when the helper already holds the
// configured maximum number of active bookings.
var ErrHelperAtMaxActive = fmt.Errorf("helper already has maximum active bookings")

// AcceptBooking atomically assigns a helper to a pending booking.
//
// Booking-side race: a single UPDATE … WHERE status='pending' RETURNING id
// claims the row in one round-trip. If RowsAffected == 0 the loser returns
// ErrAlreadyAccepted — no SELECT FOR UPDATE, no read-then-write window.
//
// Helper-side race (one helper accepting two bookings while at max-active):
// pg_advisory_xact_lock(helper_id) serialises accept attempts for a given
// helper across the cluster so the COUNT(*) → UPDATE pair is consistent.
func (r *Repository) AcceptBooking(ctx context.Context, bookingID, helperID string, maxActive int) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := r.db.BeginTx(queryCtx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("failed to begin tx: %w", err)
	}
	defer tx.Rollback(context.Background())

	if _, err := tx.Exec(queryCtx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		helperID,
	); err != nil {
		return fmt.Errorf("failed to acquire helper lock: %w", err)
	}

	var activeCount int
	if err := tx.QueryRow(queryCtx,
		`SELECT COUNT(*) FROM bookings
		 WHERE helper_id = $1 AND status IN ('accepted', 'in_progress')`,
		helperID,
	).Scan(&activeCount); err != nil {
		return fmt.Errorf("failed to count helper active bookings: %w", err)
	}
	if activeCount >= maxActive {
		return ErrHelperAtMaxActive
	}

	var customerID string
	// Accept any unassigned booking — a freshly-created 'pending' row, or a
	// legacy 'searching' row (the status is no longer produced now the invite
	// chain is retired, but old rows may still carry it). The race semantics
	// stay the same: a single UPDATE … WHERE status IN (...) RETURNING id
	// claims the row atomically; the loser (a second accept attempt) sees
	// status='accepted' and falls through to ErrAlreadyAccepted.
	if err := tx.QueryRow(queryCtx,
		`UPDATE bookings
		    SET helper_id = $2,
		        status = $3,
		        updated_at = now(),
		        accepted_at = now(),
		        matched_at = COALESCE(matched_at, now())
		  WHERE id = $1
		    AND status IN ($4, $5)
		  RETURNING customer_id::text`,
		bookingID, helperID, StatusAccepted, StatusPending, StatusSearching,
	).Scan(&customerID); err != nil {
		if err == pgx.ErrNoRows {
			return ErrAlreadyAccepted
		}
		return fmt.Errorf("failed to accept booking: %w", err)
	}

	// Emit booking.accepted so the outbox worker notifies the customer
	// even if the process crashes immediately after commit.
	if p, merr := json.Marshal(map[string]any{"booking_id": bookingID, "customer_id": customerID, "helper_id": helperID}); merr == nil {
		_, _ = tx.Exec(queryCtx,
			`INSERT INTO event_outbox (event_type, aggregate_id, payload)
			 VALUES ('booking.accepted', $1::uuid, $2::jsonb)`,
			bookingID, p)
	}

	if err := tx.Commit(queryCtx); err != nil {
		return fmt.Errorf("failed to commit accept: %w", err)
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
		        lat, lng, amount_paise, promo_code, discount_paise, created_at, updated_at
		 FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(
		&b.ID, &b.CustomerID, &b.HelperID, &b.ServiceCategoryID, &b.Status,
		&b.Address, &b.Lat, &b.Lng, &b.AmountPaise, &b.PromoCode,
		&b.DiscountPaise, &b.CreatedAt, &b.UpdatedAt,
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

// GetUnpaidBookingsForCustomer returns the count and net amount (after
// discount) of completed-but-unpaid Cashfree bookings for a customer.
// The predicate inverts compliance.moneyMovedPredicate — single source of
// truth for "money owed but not collected." Used by the soft-delete guard
// (App Store 5.1.1(v) compliance) and the re-booking guard (revenue-leak
// prevention).
func (r *Repository) GetUnpaidBookingsForCustomer(ctx context.Context, customerID string) (count int, totalPaise int64, err error) {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	err = r.db.QueryRow(queryCtx, `
		SELECT
			COUNT(*),
			COALESCE(SUM(amount_paise - COALESCE(discount_paise, 0)), 0)
		FROM bookings
		WHERE customer_id = $1
		  AND status = 'completed'
		  AND payment_method = 'cashfree'
		  AND payment_status IS DISTINCT FROM 'paid'
	`, customerID).Scan(&count, &totalPaise)
	if err != nil {
		return 0, 0, fmt.Errorf("query unpaid bookings: %w", err)
	}
	return count, totalPaise, nil
}

// GetHelperActiveBookings returns bookings assigned to this helper that are
// currently accepted or in_progress (instant or scheduled). Newest first.
func (r *Repository) GetHelperActiveBookings(ctx context.Context, helperID string) ([]Booking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Hard LIMIT — matching.max_active_per_helper is small (default 3), but
	// we never trust config to be the only cap; an explicit ceiling keeps a
	// runaway state from melting the pro dashboard.
	rows, err := r.db.Query(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, amount_paise, promo_code, discount_paise, created_at, updated_at,
		        COALESCE(pro_earnings_paise, 0)
		 FROM bookings
		 WHERE helper_id = $1 AND status IN ('accepted', 'in_progress')
		 ORDER BY updated_at DESC
		 LIMIT 50`,
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
			&b.Status, &b.Address, &b.Lat, &b.Lng, &b.AmountPaise,
			&b.PromoCode, &b.DiscountPaise, &b.CreatedAt, &b.UpdatedAt,
			&b.ProEarningsPaise); err != nil {
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
		        lat, lng, amount_paise, promo_code, discount_paise, created_at, updated_at,
		        COALESCE(pro_earnings_paise, 0)
		 FROM bookings
		 WHERE helper_id = $1
		   AND (
		     status IN ('accepted', 'in_progress')
		     OR (status IN ('completed', 'cancelled') AND (updated_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)
		   )
		 ORDER BY
		   CASE status
		     WHEN 'in_progress' THEN 0
		     WHEN 'accepted'    THEN 1
		     WHEN 'completed'   THEN 2
		     WHEN 'cancelled'   THEN 3
		     ELSE 4
		   END,
		   updated_at DESC
		 LIMIT 100`,
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
			&b.Status, &b.Address, &b.Lat, &b.Lng, &b.AmountPaise,
			&b.PromoCode, &b.DiscountPaise, &b.CreatedAt, &b.UpdatedAt,
			&b.ProEarningsPaise); err != nil {
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

	// Same Cashfree-pending-unpaid filter as GetCustomerBookingsByStatus.
	// Direct-pay rows show up only after the webhook stamps payment_status.
	rows, err := r.db.Query(queryCtx,
		`SELECT id, customer_id, helper_id, service_category_id, status, address,
		        lat, lng, amount_paise, promo_code, discount_paise, created_at, updated_at
		 FROM bookings
		 WHERE customer_id = $1
		   AND (payment_method IS DISTINCT FROM 'cashfree' OR payment_status = 'paid')
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
			&b.Status, &b.Address, &b.Lat, &b.Lng, &b.AmountPaise,
			&b.PromoCode, &b.DiscountPaise, &b.CreatedAt, &b.UpdatedAt); err != nil {
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
//
// Stealth-instant params (set by the service layer when the customer books
// after the 8pm IST cutoff): isStealthInstant=true + a non-nil fireAt point
// the dispatch crons at the right path. locality is the snapshot derived from
// the address, used by the invite chain to filter pros.
func (r *Repository) CreateScheduledBooking(
	ctx context.Context,
	customerID, addressID, timeSlotID string,
	scheduledTime string,
	items []BookingServiceItem,
	totalPriceCents, discountCents int,
	promoCode *string,
	isStealthInstant bool,
	fireAt *time.Time,
	locality *string,
	enforceCapacity bool,
) (*ScheduledBooking, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.db.Begin(queryCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(queryCtx)

	// Capacity gate. Capacity is live-derived — there is no counter column:
	// approved roster helpers in the locality, minus those on approved leave
	// that date, minus committed bookings whose window overlaps this slot
	// (see availableForSlot). Cancellations free capacity automatically. An
	// advisory xact lock keyed by (locality, date) — NOT the slot — serialises
	// every concurrent booking in that locality+date so the re-count can't race
	// two inserts past a single remaining seat. The slot id is deliberately
	// excluded: committedCountForSlot counts bookings whose window overlaps
	// across slot boundaries (a 60-min 09:00 job also counts against 09:30), so
	// per-slot locking would let two overlapping-but-different slots skip the
	// lock and double-book (audit fix b939794). Other localities/dates are
	// unaffected and the lock auto-releases on commit/rollback. Capacity is
	// enforced only for the scheduled flow (enforceCapacity); the instant/cart
	// path passes false.
	// ASAP bookings carry no slot (timeSlotID==""): scheduled_time is "now" and
	// the slot row is irrelevant, so skip the time_slots lookup entirely and
	// store NULL for time_slot_id (the column is a UUID — binding "" would throw
	// 22P02). The capacity gate below never runs for ASAP (enforceCapacity=false).
	var slotDate string
	var timeSlotIDArg any // nil for ASAP, the uuid string for a real slot
	if timeSlotID != "" {
		var isActive bool
		err = tx.QueryRow(queryCtx,
			`SELECT to_char(slot_date, 'YYYY-MM-DD'), is_active
			 FROM time_slots
			 WHERE id = $1`,
			timeSlotID,
		).Scan(&slotDate, &isActive)
		if err != nil {
			if err == pgx.ErrNoRows {
				return nil, ErrSlotUnavailable
			}
			return nil, fmt.Errorf("failed to load time slot: %w", err)
		}
		if !isActive {
			return nil, ErrSlotUnavailable
		}
		timeSlotIDArg = timeSlotID
	}

	if enforceCapacity && timeSlotID != "" && locality != nil && *locality != "" {
		lockKey := *locality + "|" + slotDate
		if _, err := tx.Exec(queryCtx,
			`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
			lockKey,
		); err != nil {
			return nil, fmt.Errorf("failed to acquire slot capacity lock: %w", err)
		}
		avail, err := r.availableForSlot(queryCtx, tx, *locality, timeSlotID, slotDate)
		if err != nil {
			return nil, fmt.Errorf("failed to compute slot capacity: %w", err)
		}
		if avail <= 0 {
			return nil, ErrSlotUnavailable
		}
	}

	// Calculate total duration.
	totalDuration := 0
	for _, item := range items {
		totalDuration += item.DurationMinutes
	}

	// Use a placeholder service_category_id (first item) for the legacy column.
	legacyServiceID := items[0].ServiceID

	// Resolve the delivery address inside the same tx — the booking row must
	// carry real coords/address: the pro arrived-radius gate (MarkArrivedGated)
	// compares against bookings.lat/lng, Navigate opens them, and the matcher's
	// pending rescan reads them. Previously hardcoded '',0,0 — the arrived gate
	// then compared against (0,0) and scheduled jobs could never start.
	// Scoped to customerID so a forged address_id cannot attach another user's
	// address.
	var addrText string
	var addrLat, addrLng float64
	if err := tx.QueryRow(queryCtx,
		`SELECT COALESCE(full_address, ''), lat, lon
		 FROM user_addresses WHERE id = $1::uuid AND user_id = $2::uuid`,
		addressID, customerID,
	).Scan(&addrText, &addrLat, &addrLng); err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("failed to resolve booking address: address not found for customer")
		}
		return nil, fmt.Errorf("failed to resolve booking address: %w", err)
	}

	var b ScheduledBooking
	err = tx.QueryRow(queryCtx,
		`INSERT INTO bookings
		   (customer_id, service_category_id, status, address, lat, lng,
		    amount_paise, discount_paise, promo_code,
		    address_id, time_slot_id, scheduled_time, total_duration_minutes,
		    is_stealth_instant, fire_at, locality)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		 RETURNING id, customer_id, address_id, time_slot_id,
		           to_char(scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		           total_duration_minutes, status, amount_paise, discount_paise, promo_code, created_at`,
		customerID, legacyServiceID, StatusPending,
		addrText, addrLat, addrLng,
		totalPriceCents, discountCents, promoCode,
		addressID, timeSlotIDArg, scheduledTime, totalDuration,
		isStealthInstant, fireAt, locality,
	).Scan(
		&b.ID, &b.CustomerID, &b.AddressID, &b.TimeSlotID, &b.ScheduledTime,
		&b.TotalDurationMinutes, &b.Status, &b.AmountPaise, &b.DiscountPaise,
		&b.PromoCode, &b.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create scheduled booking: %w", err)
	}

	// Insert booking_services rows.
	for _, item := range items {
		_, err := tx.Exec(queryCtx,
			// Column was renamed to price_paise by migration 094 (the
			// idempotent recovery for the 2026-05-14 incident). The Go
			// struct field is still named PriceCents internally but the
			// value has always been paise — see BREAKING_CHANGES.md.
			`INSERT INTO booking_services (booking_id, service_id, duration_minutes, price_paise)
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

	// Filter out Cashfree-pending unpaid bookings from the customer-facing
	// list. A direct-pay booking is created in 'pending' status with
	// payment_method='cashfree' BEFORE the SDK sheet opens; if the user
	// abandons the payment, the row stays pending forever. Hide it until
	// the PAYMENT_SUCCESS webhook flips payment_status='paid'. Wallet-pay
	// (payment_method='wallet', stamped paid inline) and legacy COD/null
	// bookings continue to surface as before.
	// Columns MUST be b.-qualified: the query below joins booking_services /
	// service_categories / user_addresses, and a bare `status` is ambiguous
	// once any joined table also carries one (SQLSTATE 42702 — every
	// "upcoming" fetch 500'd).
	const hidePendingUnpaidCashfree = `
		(b.payment_method IS DISTINCT FROM 'cashfree' OR b.payment_status = 'paid')
	`
	var statusFilter string
	switch status {
	case "upcoming":
		statusFilter = `b.status IN ('pending', 'accepted', 'in_progress') AND ` + hidePendingUnpaidCashfree
	case "past":
		statusFilter = `b.status IN ('completed', 'cancelled')`
	default:
		statusFilter = `true`
	}

	rows, err := r.db.Query(queryCtx, `
		SELECT
			b.id, b.customer_id, b.address_id, ua.tag, ua.title, b.time_slot_id,
			to_char(b.scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS scheduled_time,
			b.total_duration_minutes, b.status, b.amount_paise, b.discount_paise, b.promo_code, b.created_at,
			COALESCE(
				json_agg(
					json_build_object(
						'service_id', bs.service_id::text,
						'service_name', sc.name,
						'duration_minutes', bs.duration_minutes,
						-- JSON key is price_paise to match the renamed schema
						-- column and the mobile TS type. Value is paise.
						'price_paise', bs.price_paise
					)
					ORDER BY bs.id
				) FILTER (WHERE bs.service_id IS NOT NULL),
				'[]'::json
			) AS services
		FROM bookings b
		LEFT JOIN booking_services bs ON bs.booking_id = b.id
		LEFT JOIN service_categories sc ON sc.id = bs.service_id
		LEFT JOIN user_addresses ua ON ua.id = b.address_id
		WHERE b.customer_id = $1
		  AND `+statusFilter+`
		GROUP BY b.id, b.customer_id, b.address_id, ua.tag, ua.title, b.time_slot_id, b.scheduled_time,
		         b.total_duration_minutes, b.status, b.amount_paise, b.discount_paise, b.promo_code, b.created_at
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
			&b.ID, &b.CustomerID, &b.AddressID, &b.AddressTag, &b.AddressTitle, &b.TimeSlotID, &b.ScheduledTime,
			&b.TotalDurationMinutes, &b.Status, &b.AmountPaise, &b.DiscountPaise,
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
