package addresses

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrAddressInUse is returned when deleting an address that is referenced by bookings.
var ErrAddressInUse = errors.New("address is used by existing bookings and cannot be deleted")

// ErrAddressHasGroup is returned when deleting an address that has an active household group.
var ErrAddressHasGroup = errors.New("address has an active household group — dissolve the group before deleting this address")

// Repository handles database operations for user addresses.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new addresses repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// ListByUser returns all saved addresses for a user, newest first.
func (r *Repository) ListByUser(ctx context.Context, userID string) ([]Address, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, user_id, tag, title, flat_no, floor, building_name, landmark,
		        full_address, receiver_name, receiver_phone, lat, lon, created_at
		 FROM user_addresses
		 WHERE user_id = $1
		 ORDER BY created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list addresses: %w", err)
	}
	defer rows.Close()

	var addrs []Address
	for rows.Next() {
		var a Address
		if err := rows.Scan(
			&a.ID, &a.UserID, &a.Tag, &a.Title, &a.FlatNo, &a.Floor,
			&a.BuildingName, &a.Landmark, &a.FullAddress,
			&a.ReceiverName, &a.ReceiverPhone, &a.Lat, &a.Lon, &a.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan address: %w", err)
		}
		addrs = append(addrs, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("row iteration error: %w", err)
	}

	if addrs == nil {
		addrs = []Address{}
	}
	return addrs, nil
}

// Create inserts a new address and returns the created record.
func (r *Repository) Create(ctx context.Context, userID string, req CreateAddressRequest) (*Address, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Enforce one Home / one Work per user: demote any existing same-tag address to Other.
	if req.Tag == "Home" || req.Tag == "Work" {
		_, err := r.db.Exec(queryCtx,
			`UPDATE user_addresses SET tag = 'Other', updated_at = now()
			 WHERE user_id = $1 AND tag = $2`,
			userID, req.Tag,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to demote existing %s address: %w", req.Tag, err)
		}
	}

	a := &Address{}
	err := r.db.QueryRow(queryCtx,
		`INSERT INTO user_addresses
		   (user_id, tag, title, flat_no, floor, building_name, landmark,
		    full_address, receiver_name, receiver_phone, lat, lon)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		 RETURNING id, user_id, tag, title, flat_no, floor, building_name, landmark,
		           full_address, receiver_name, receiver_phone, lat, lon, created_at`,
		userID, req.Tag, req.Title, req.FlatNo, req.Floor, req.BuildingName,
		req.Landmark, req.FullAddress, req.ReceiverName, req.ReceiverPhone,
		req.Lat, req.Lon,
	).Scan(
		&a.ID, &a.UserID, &a.Tag, &a.Title, &a.FlatNo, &a.Floor,
		&a.BuildingName, &a.Landmark, &a.FullAddress,
		&a.ReceiverName, &a.ReceiverPhone, &a.Lat, &a.Lon, &a.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create address: %w", err)
	}
	return a, nil
}

// Update modifies an existing address. Only non-empty fields are applied.
func (r *Repository) Update(ctx context.Context, userID, addressID string, req UpdateAddressRequest) (*Address, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Enforce one Home / one Work per user: demote conflicting address (excluding this one).
	if req.Tag == "Home" || req.Tag == "Work" {
		_, err := r.db.Exec(queryCtx,
			`UPDATE user_addresses SET tag = 'Other', updated_at = now()
			 WHERE user_id = $1 AND tag = $2 AND id != $3`,
			userID, req.Tag, addressID,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to demote existing %s address: %w", req.Tag, err)
		}
	}

	a := &Address{}
	err := r.db.QueryRow(queryCtx,
		`UPDATE user_addresses SET
		    tag           = CASE WHEN $3 <> '' THEN $3 ELSE tag END,
		    title         = CASE WHEN $4 <> '' THEN $4 ELSE title END,
		    flat_no       = CASE WHEN $5 <> '' THEN $5 ELSE flat_no END,
		    floor         = CASE WHEN $6 <> '' THEN $6 ELSE floor END,
		    building_name = CASE WHEN $7 <> '' THEN $7 ELSE building_name END,
		    landmark      = CASE WHEN $8 <> '' THEN $8 ELSE landmark END,
		    full_address  = CASE WHEN $9 <> '' THEN $9 ELSE full_address END,
		    receiver_name = CASE WHEN $10 <> '' THEN $10 ELSE receiver_name END,
		    receiver_phone= CASE WHEN $11 <> '' THEN $11 ELSE receiver_phone END,
		    lat           = CASE WHEN $12 <> 0  THEN $12 ELSE lat END,
		    lon           = CASE WHEN $13 <> 0  THEN $13 ELSE lon END,
		    updated_at    = now()
		 WHERE id = $1 AND user_id = $2
		 RETURNING id, user_id, tag, title, flat_no, floor, building_name, landmark,
		           full_address, receiver_name, receiver_phone, lat, lon, created_at`,
		addressID, userID,
		req.Tag, req.Title, req.FlatNo, req.Floor, req.BuildingName,
		req.Landmark, req.FullAddress, req.ReceiverName, req.ReceiverPhone,
		req.Lat, req.Lon,
	).Scan(
		&a.ID, &a.UserID, &a.Tag, &a.Title, &a.FlatNo, &a.Floor,
		&a.BuildingName, &a.Landmark, &a.FullAddress,
		&a.ReceiverName, &a.ReceiverPhone, &a.Lat, &a.Lon, &a.CreatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, pgx.ErrNoRows
		}
		return nil, fmt.Errorf("failed to update address: %w", err)
	}
	return a, nil
}

// Delete removes an address by ID, scoped to the owning user.
// Returns ErrNotFound if the address does not exist or belongs to another user.
func (r *Repository) Delete(ctx context.Context, userID, addressID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := r.db.Begin(queryCtx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(queryCtx)

	// SECURITY: verify ownership FIRST. Previously the booking-nullify ran
	// before the owner check, which let any authenticated user wipe
	// address_id off another user's bookings by submitting a foreign UUID.
	var owns bool
	if err := tx.QueryRow(queryCtx,
		`SELECT EXISTS(SELECT 1 FROM user_addresses WHERE id=$1 AND user_id=$2)`,
		addressID, userID,
	).Scan(&owns); err != nil {
		return fmt.Errorf("failed to verify address ownership: %w", err)
	}
	if !owns {
		return pgx.ErrNoRows
	}

	// Block deletion if a household group is attached to this address.
	var groupCount int
	if err := tx.QueryRow(queryCtx,
		`SELECT COUNT(*) FROM address_groups WHERE address_id = $1`,
		addressID,
	).Scan(&groupCount); err != nil {
		return fmt.Errorf("failed to check for household group: %w", err)
	}
	if groupCount > 0 {
		return ErrAddressHasGroup
	}

	// Nullify any booking references so historical records are preserved.
	if _, err := tx.Exec(queryCtx,
		`UPDATE bookings SET address_id = NULL WHERE address_id = $1`,
		addressID,
	); err != nil {
		return fmt.Errorf("failed to nullify booking references: %w", err)
	}

	tag, err := tx.Exec(queryCtx,
		`DELETE FROM user_addresses WHERE id = $1 AND user_id = $2`,
		addressID, userID,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return ErrAddressInUse
		}
		return fmt.Errorf("failed to delete address: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}

	if err := tx.Commit(queryCtx); err != nil {
		return fmt.Errorf("failed to commit address deletion: %w", err)
	}
	return nil
}
