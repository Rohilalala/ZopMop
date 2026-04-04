package zones

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository handles DB operations for service zones.
type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// CheckServiceability returns a matching zone if the given lat/lon falls within
// any active zone's radius, using a single Haversine query.
func (r *Repository) CheckServiceability(ctx context.Context, lat, lon float64) (*ServiceZone, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var z ServiceZone
	err := r.db.QueryRow(ctx, `
		SELECT id, name, city, lat, lon, radius_km, is_active, created_at
		FROM service_zones
		WHERE is_active = true
		  AND (6371 * acos(
		          LEAST(1.0,
		              cos(radians($1)) * cos(radians(lat::float8))
		              * cos(radians(lon::float8) - radians($2))
		              + sin(radians($1)) * sin(radians(lat::float8))
		          )
		      )) <= radius_km::float8
		LIMIT 1
	`, lat, lon).Scan(
		&z.ID, &z.Name, &z.City, &z.Lat, &z.Lon,
		&z.RadiusKm, &z.IsActive, &z.CreatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil // outside all zones
		}
		return nil, err
	}
	return &z, nil
}

// ListZones returns all zones (for admin use).
func (r *Repository) ListZones(ctx context.Context) ([]ServiceZone, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx, `
		SELECT id, name, city, lat, lon, radius_km, is_active, created_at
		FROM service_zones ORDER BY city, name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var zones []ServiceZone
	for rows.Next() {
		var z ServiceZone
		if err := rows.Scan(&z.ID, &z.Name, &z.City, &z.Lat, &z.Lon,
			&z.RadiusKm, &z.IsActive, &z.CreatedAt); err != nil {
			return nil, err
		}
		zones = append(zones, z)
	}
	if zones == nil {
		zones = []ServiceZone{}
	}
	return zones, rows.Err()
}
