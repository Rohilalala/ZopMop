package helper

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository handles database access for the helper module.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new helper repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// GetProfile returns the helper's profile by joining helpers + users.
func (r *Repository) GetProfile(ctx context.Context, helperID string) (*Profile, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var p Profile
	err := r.db.QueryRow(ctx,
		`SELECT u.id,
		        COALESCE(u.name, '') AS name,
		        u.phone,
		        COALESCE(h.rating, 5.00) AS rating,
		        COALESCE(h.total_jobs, 0) AS total_jobs,
		        h.is_available,
		        h.created_at
		 FROM helpers h
		 JOIN users u ON u.id = h.id
		 WHERE h.id = $1`,
		helperID,
	).Scan(&p.ID, &p.Name, &p.Phone, &p.Rating, &p.TotalJobs, &p.IsAvailable, &p.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("helper not found: %w", err)
	}
	return &p, nil
}

// GetBookingInviteDetails fetches booking details for a list of booking IDs.
// Only returns pending bookings (accepted ones no longer need to be shown).
func (r *Repository) GetBookingInviteDetails(ctx context.Context, bookingIDs []string) ([]Invite, error) {
	if len(bookingIDs) == 0 {
		return []Invite{}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT
		   b.id,
		   COALESCE(u.name, 'Customer')              AS customer_name,
		   COALESCE(a.full_address, b.address, '')   AS address,
		   COALESCE(a.lat,  b.lat,  0.0)             AS lat,
		   COALESCE(a.lon,  b.lng,  0.0)             AS lng,
		   COALESCE(b.total_duration_minutes, 0)     AS total_minutes,
		   b.price_cents,
		   b.created_at
		 FROM bookings b
		 JOIN users u ON u.id = b.customer_id
		 LEFT JOIN user_addresses a ON a.id = b.address_id
		 WHERE b.id = ANY($1::uuid[])
		   AND b.status = 'pending'
		 ORDER BY b.created_at DESC`,
		bookingIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query invites: %w", err)
	}
	defer rows.Close()

	inviteMap := make(map[string]*Invite)
	var orderedIDs []string
	for rows.Next() {
		inv := &Invite{}
		if err := rows.Scan(
			&inv.BookingID, &inv.CustomerName, &inv.Address,
			&inv.Lat, &inv.Lng, &inv.TotalMinutes, &inv.PriceCents, &inv.CreatedAt,
		); err != nil {
			continue
		}
		inv.Services = []string{}
		inviteMap[inv.BookingID] = inv
		orderedIDs = append(orderedIDs, inv.BookingID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Fetch service names per booking.
	svcRows, err := r.db.Query(ctx,
		`SELECT bs.booking_id, sc.name
		 FROM booking_services bs
		 JOIN service_categories sc ON sc.id = bs.service_id
		 WHERE bs.booking_id = ANY($1::uuid[])
		 ORDER BY bs.booking_id`,
		bookingIDs,
	)
	if err == nil {
		defer svcRows.Close()
		for svcRows.Next() {
			var bid, svcName string
			if svcRows.Scan(&bid, &svcName) == nil {
				if inv, ok := inviteMap[bid]; ok {
					inv.Services = append(inv.Services, svcName)
				}
			}
		}
	}

	out := make([]Invite, 0, len(orderedIDs))
	for _, id := range orderedIDs {
		if inv, ok := inviteMap[id]; ok {
			out = append(out, *inv)
		}
	}
	return out, nil
}

// SetAvailability updates the helper's is_available flag in Postgres.
func (r *Repository) SetAvailability(ctx context.Context, helperID string, available bool) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := r.db.Exec(ctx,
		`UPDATE helpers SET is_available = $1 WHERE id = $2`,
		available, helperID,
	)
	return err
}

// GetLastLocation returns the helper's most recent persisted lat/lng.
// Returns (0, 0, false) when the helper has never sent a location.
func (r *Repository) GetLastLocation(ctx context.Context, helperID string) (float64, float64, bool) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var lat, lng *float64
	err := r.db.QueryRow(ctx,
		`SELECT current_lat, current_lng FROM helpers WHERE id = $1`,
		helperID,
	).Scan(&lat, &lng)
	if err != nil || lat == nil || lng == nil {
		return 0, 0, false
	}
	return *lat, *lng, true
}

// UpdateLocation stores the helper's lat/lng and hex cell in Postgres.
func (r *Repository) UpdateLocation(ctx context.Context, helperID string, lat, lng float64, cellID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := r.db.Exec(ctx,
		`UPDATE helpers
		 SET current_lat  = $1,
		     current_lng  = $2,
		     hex_cell_id  = $3,
		     is_available = true
		 WHERE id = $4`,
		lat, lng, cellID, helperID,
	)
	return err
}
