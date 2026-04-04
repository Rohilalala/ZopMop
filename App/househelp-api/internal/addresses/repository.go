package addresses

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

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

	tag, err := r.db.Exec(queryCtx,
		`DELETE FROM user_addresses WHERE id = $1 AND user_id = $2`,
		addressID, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to delete address: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}
