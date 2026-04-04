package services

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository handles database access for the services catalog.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new services repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// List returns all active services ordered by display_order.
func (r *Repository) List(ctx context.Context) ([]Service, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT id, name, description, short_description, emoji, bg_color,
		        base_price_cents, mrp_cents, rating, review_count,
		        min_duration_minutes, max_duration_minutes, duration_step_minutes,
		        is_active, display_order, created_at
		 FROM service_categories WHERE is_active = true ORDER BY display_order ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query services: %w", err)
	}
	defer rows.Close()

	var list []Service
	for rows.Next() {
		var s Service
		if err := rows.Scan(
			&s.ID, &s.Name, &s.Description, &s.ShortDescription, &s.Emoji, &s.BgColor,
			&s.BasePriceCents, &s.MrpCents, &s.Rating, &s.ReviewCount,
			&s.MinDurationMinutes, &s.MaxDurationMinutes, &s.DurationStepMinutes,
			&s.IsActive, &s.DisplayOrder, &s.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan service: %w", err)
		}
		list = append(list, s)
	}
	if list == nil {
		list = []Service{}
	}
	return list, rows.Err()
}

// GetByID returns a single service by ID.
func (r *Repository) GetByID(ctx context.Context, serviceID string) (*Service, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var s Service
	err := r.db.QueryRow(ctx,
		`SELECT id, name, description, short_description, emoji, bg_color,
		        base_price_cents, mrp_cents, rating, review_count,
		        min_duration_minutes, max_duration_minutes, duration_step_minutes,
		        is_active, display_order, created_at
		 FROM service_categories WHERE id = $1`, serviceID,
	).Scan(
		&s.ID, &s.Name, &s.Description, &s.ShortDescription, &s.Emoji, &s.BgColor,
		&s.BasePriceCents, &s.MrpCents, &s.Rating, &s.ReviewCount,
		&s.MinDurationMinutes, &s.MaxDurationMinutes, &s.DurationStepMinutes,
		&s.IsActive, &s.DisplayOrder, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// GetDetails returns the service plus its includes, excludes, and steps.
func (r *Repository) GetDetails(ctx context.Context, serviceID string) (*ServiceDetails, error) {
	svc, err := r.GetByID(ctx, serviceID)
	if err != nil {
		return nil, err
	}

	includes, err := r.listIncludes(ctx, serviceID)
	if err != nil {
		return nil, err
	}
	excludes, err := r.listExcludes(ctx, serviceID)
	if err != nil {
		return nil, err
	}
	steps, err := r.listSteps(ctx, serviceID)
	if err != nil {
		return nil, err
	}

	return &ServiceDetails{
		Service:  svc,
		Includes: includes,
		Excludes: excludes,
		Steps:    steps,
	}, nil
}

// GetAddons returns add-on services for a base service.
func (r *Repository) GetAddons(ctx context.Context, serviceID string) ([]ServiceAddon, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT sc.id, sc.name, sc.emoji, sc.bg_color, sc.base_price_cents, sa.display_order
		 FROM service_addons sa
		 JOIN service_categories sc ON sc.id = sa.addon_service_id
		 WHERE sa.service_id = $1 ORDER BY sa.display_order ASC`,
		serviceID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query addons: %w", err)
	}
	defer rows.Close()

	var addons []ServiceAddon
	for rows.Next() {
		var a ServiceAddon
		if err := rows.Scan(&a.ID, &a.Name, &a.Emoji, &a.BgColor, &a.BasePriceCents, &a.DisplayOrder); err != nil {
			return nil, fmt.Errorf("failed to scan addon: %w", err)
		}
		addons = append(addons, a)
	}
	if addons == nil {
		addons = []ServiceAddon{}
	}
	return addons, rows.Err()
}

func (r *Repository) listIncludes(ctx context.Context, serviceID string) ([]ServiceInclude, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT id, item, display_order FROM service_includes
		 WHERE service_id = $1 ORDER BY display_order ASC`, serviceID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query includes: %w", err)
	}
	defer rows.Close()

	var list []ServiceInclude
	for rows.Next() {
		var inc ServiceInclude
		if err := rows.Scan(&inc.ID, &inc.Item, &inc.DisplayOrder); err != nil {
			return nil, err
		}
		list = append(list, inc)
	}
	if list == nil {
		list = []ServiceInclude{}
	}
	return list, rows.Err()
}

func (r *Repository) listExcludes(ctx context.Context, serviceID string) ([]ServiceExclude, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT id, item, display_order FROM service_excludes
		 WHERE service_id = $1 ORDER BY display_order ASC`, serviceID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query excludes: %w", err)
	}
	defer rows.Close()

	var list []ServiceExclude
	for rows.Next() {
		var exc ServiceExclude
		if err := rows.Scan(&exc.ID, &exc.Item, &exc.DisplayOrder); err != nil {
			return nil, err
		}
		list = append(list, exc)
	}
	if list == nil {
		list = []ServiceExclude{}
	}
	return list, rows.Err()
}

func (r *Repository) listSteps(ctx context.Context, serviceID string) ([]ServiceStep, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT id, step_number, title, description, icon FROM service_steps
		 WHERE service_id = $1 ORDER BY step_number ASC`, serviceID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query steps: %w", err)
	}
	defer rows.Close()

	var list []ServiceStep
	for rows.Next() {
		var step ServiceStep
		if err := rows.Scan(&step.ID, &step.StepNumber, &step.Title, &step.Description, &step.Icon); err != nil {
			return nil, err
		}
		list = append(list, step)
	}
	if list == nil {
		list = []ServiceStep{}
	}
	return list, rows.Err()
}
