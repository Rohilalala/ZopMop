package helper

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrHelperNotFound is returned when a helpers row is missing for the
// authenticated user. Pro JWTs reach helper endpoints before the helpers
// row is seeded (in dev or after a partial signup), and we want callers to
// see a clean 404 instead of a generic 500.
var ErrHelperNotFound = errors.New("helper: row not found")

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
		   b.amount_paise,
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
			&inv.Lat, &inv.Lng, &inv.TotalMinutes, &inv.AmountPaise, &inv.CreatedAt,
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

// SetAvailability flips the helper's is_available flag and, only when the
// value actually changes, appends a row to helper_status_log. Returns
// (changed, error). The caller uses `changed` to decide whether to emit
// downstream events (analytics + webhook) — re-toggling to the same value is
// a no-op so we don't spam an "online" event every heartbeat.
//
// The UPDATE + INSERT run in one transaction so the log can never get out of
// sync with the live flag.
func (r *Repository) SetAvailability(ctx context.Context, helperID string, available bool) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var prev bool
	if err := tx.QueryRow(ctx,
		`SELECT is_available FROM helpers WHERE id = $1 FOR UPDATE`,
		helperID,
	).Scan(&prev); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, ErrHelperNotFound
		}
		return false, fmt.Errorf("load helper: %w", err)
	}
	if prev == available {
		return false, tx.Commit(ctx)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE helpers SET is_available = $1 WHERE id = $2`,
		available, helperID,
	); err != nil {
		return false, fmt.Errorf("update helper: %w", err)
	}

	statusStr := "offline"
	if available {
		statusStr = "online"
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO helper_status_log (helper_id, status) VALUES ($1, $2)`,
		helperID, statusStr,
	); err != nil {
		return false, fmt.Errorf("insert status log: %w", err)
	}
	return true, tx.Commit(ctx)
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
// Returns ErrHelperNotFound when the authenticated pro has no helpers row
// yet (e.g. partial signup) so the handler can map it to 404 rather than
// surfacing a generic 500.
func (r *Repository) UpdateLocation(ctx context.Context, helperID string, lat, lng float64, cellID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Also write the PostGIS `location` geography column — the matching
	// engine's nearest-neighbour query filters `h.location IS NOT NULL` and
	// orders by `<-> ST_SetSRID(...)::geography`, so a row with current_lat/
	// current_lng populated but `location` NULL is invisible to dispatch.
	tag, err := r.db.Exec(ctx,
		`UPDATE helpers
		 SET current_lat      = $1::numeric,
		     current_lng      = $2::numeric,
		     hex_cell_id      = $3,
		     is_available     = true,
		     last_location_at = NOW(),
		     location         = ST_SetSRID(ST_MakePoint($2::float8, $1::float8), 4326)::geography
		 WHERE id = $4`,
		lat, lng, cellID, helperID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrHelperNotFound
	}
	return nil
}

// UpdateLocality validates the locality against active localities (case
// insensitive). Empty/whitespace clears the field. Returns a friendly
// error if the locality isn't on the active list.
func (r *Repository) UpdateLocality(ctx context.Context, helperID, locality string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	loc := strings.TrimSpace(locality)
	if loc == "" {
		_, err := r.db.Exec(ctx, `UPDATE helpers SET locality = NULL WHERE id = $1::uuid`, helperID)
		return err
	}
	var canonical string
	err := r.db.QueryRow(ctx, `
		SELECT name FROM localities WHERE active = true AND name ILIKE $1 LIMIT 1
	`, loc).Scan(&canonical)
	if err != nil {
		return fmt.Errorf("unknown locality")
	}
	_, err = r.db.Exec(ctx, `UPDATE helpers SET locality = $2 WHERE id = $1::uuid`, helperID, canonical)
	return err
}
