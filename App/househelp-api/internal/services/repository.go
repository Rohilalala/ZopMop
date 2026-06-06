package services

import (
	"context"
	"fmt"
	"strings"
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
		        is_active, display_order, created_at, category
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
			&s.IsActive, &s.DisplayOrder, &s.CreatedAt, &s.Category,
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

// ListAll returns all services (including inactive) ordered by display_order.
// Used by the admin panel.
func (r *Repository) ListAll(ctx context.Context) ([]Service, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT id, name, description, short_description, emoji, bg_color,
		        base_price_cents, mrp_cents, rating, review_count,
		        min_duration_minutes, max_duration_minutes, duration_step_minutes,
		        is_active, display_order, created_at, category
		 FROM service_categories ORDER BY display_order ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query all services: %w", err)
	}
	defer rows.Close()

	var list []Service
	for rows.Next() {
		var s Service
		if err := rows.Scan(
			&s.ID, &s.Name, &s.Description, &s.ShortDescription, &s.Emoji, &s.BgColor,
			&s.BasePriceCents, &s.MrpCents, &s.Rating, &s.ReviewCount,
			&s.MinDurationMinutes, &s.MaxDurationMinutes, &s.DurationStepMinutes,
			&s.IsActive, &s.DisplayOrder, &s.CreatedAt, &s.Category,
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

// Update applies a partial update to a service category and returns the updated record.
func (r *Repository) Update(ctx context.Context, id string, req AdminUpdateServiceRequest) (*Service, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Build SET clause dynamically from non-zero fields.
	setClauses := []string{"updated_at = NOW()"}
	args := []any{}
	i := 1

	if req.Name != "" {
		setClauses = append(setClauses, fmt.Sprintf("name = $%d", i))
		args = append(args, strings.TrimSpace(req.Name))
		i++
	}
	if req.BasePriceCents != nil && *req.BasePriceCents > 0 {
		setClauses = append(setClauses, fmt.Sprintf("base_price_cents = $%d", i))
		args = append(args, *req.BasePriceCents)
		i++
	}
	if req.IsActive != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_active = $%d", i))
		args = append(args, *req.IsActive)
		i++
	}
	if req.DisplayOrder != nil {
		setClauses = append(setClauses, fmt.Sprintf("display_order = $%d", i))
		args = append(args, *req.DisplayOrder)
		i++
	}
	if req.Emoji != nil {
		setClauses = append(setClauses, fmt.Sprintf("emoji = $%d", i))
		args = append(args, *req.Emoji)
		i++
	}
	if req.BgColor != "" {
		setClauses = append(setClauses, fmt.Sprintf("bg_color = $%d", i))
		args = append(args, req.BgColor)
		i++
	}
	if req.Category != "" {
		setClauses = append(setClauses, fmt.Sprintf("category = $%d", i))
		args = append(args, req.Category)
		i++
	}

	if len(setClauses) == 1 {
		// Nothing to update — return current record.
		return r.GetByID(ctx, id)
	}

	query := "UPDATE service_categories SET "
	for j, c := range setClauses {
		if j > 0 {
			query += ", "
		}
		query += c
	}
	query += fmt.Sprintf(" WHERE id = $%d", i)
	args = append(args, id)

	res, err := r.db.Exec(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to update service: %w", err)
	}
	if res.RowsAffected() == 0 {
		return nil, fmt.Errorf("service not found")
	}
	return r.GetByID(ctx, id)
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
		        is_active, display_order, created_at, category
		 FROM service_categories WHERE id = $1`, serviceID,
	).Scan(
		&s.ID, &s.Name, &s.Description, &s.ShortDescription, &s.Emoji, &s.BgColor,
		&s.BasePriceCents, &s.MrpCents, &s.Rating, &s.ReviewCount,
		&s.MinDurationMinutes, &s.MaxDurationMinutes, &s.DurationStepMinutes,
		&s.IsActive, &s.DisplayOrder, &s.CreatedAt, &s.Category,
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
	faqs, err := r.listFaqs(ctx, serviceID)
	if err != nil {
		return nil, err
	}

	return &ServiceDetails{
		Service:  svc,
		Includes: includes,
		Excludes: excludes,
		Steps:    steps,
		Faqs:     faqs,
	}, nil
}

// listFaqs returns the resolved FAQ list for a service: the non-overridden
// global faq_items followed by the per-service service_faqs. A per-service FAQ
// suppresses any global FAQ that shares the same question, so a service never
// shows two contradictory answers (e.g. Pre and Post Party Clean overrides the
// global price FAQ with its fixed-90-minute version).
func (r *Repository) listFaqs(ctx context.Context, serviceID string) ([]ServiceFaq, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Per-service FAQs first (supplies line + any override like the party price FAQ).
	svcRows, err := r.db.Query(ctx,
		`SELECT question, answer, display_order FROM service_faqs
		 WHERE service_id = $1 ORDER BY display_order ASC LIMIT 50`, serviceID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query service faqs: %w", err)
	}
	var perService []ServiceFaq
	overridden := make(map[string]bool)
	for svcRows.Next() {
		var f ServiceFaq
		if err := svcRows.Scan(&f.Question, &f.Answer, &f.DisplayOrder); err != nil {
			svcRows.Close()
			return nil, err
		}
		perService = append(perService, f)
		overridden[f.Question] = true
	}
	err = svcRows.Err()
	svcRows.Close()
	if err != nil {
		return nil, err
	}

	// Global FAQs, skipping any question a per-service FAQ overrides.
	gRows, err := r.db.Query(ctx,
		`SELECT question, answer, display_order FROM faq_items
		 WHERE is_active = true ORDER BY display_order ASC LIMIT 50`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query global faqs: %w", err)
	}
	defer gRows.Close()

	var globals []ServiceFaq
	for gRows.Next() {
		var f ServiceFaq
		if err := gRows.Scan(&f.Question, &f.Answer, &f.DisplayOrder); err != nil {
			return nil, err
		}
		if overridden[f.Question] {
			continue
		}
		globals = append(globals, f)
	}
	if err := gRows.Err(); err != nil {
		return nil, err
	}

	// Non-overridden globals (pro-safety, price) first, then per-service (supplies, overrides).
	faqs := append(globals, perService...)
	if faqs == nil {
		faqs = []ServiceFaq{}
	}
	return faqs, nil
}

// GetAddons returns add-on services for a base service.
func (r *Repository) GetAddons(ctx context.Context, serviceID string) ([]ServiceAddon, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(ctx,
		`SELECT sc.id, sc.name, sc.emoji, sc.bg_color, sc.base_price_cents, sa.display_order
		 FROM service_addons sa
		 JOIN service_categories sc ON sc.id = sa.addon_service_id
		 WHERE sa.service_id = $1 ORDER BY sa.display_order ASC LIMIT 50`,
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
		 WHERE service_id = $1 ORDER BY display_order ASC LIMIT 100`, serviceID,
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
		 WHERE service_id = $1 ORDER BY display_order ASC LIMIT 100`, serviceID,
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
		 WHERE service_id = $1 ORDER BY step_number ASC LIMIT 50`, serviceID,
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

// Create inserts a new service category and returns the created record.
func (r *Repository) Create(ctx context.Context, req AdminCreateServiceRequest) (*Service, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if req.BgColor == "" {
		req.BgColor = "#EEF2FF"
	}
	if req.MinDurationMinutes == 0 {
		req.MinDurationMinutes = 30
	}
	if req.MaxDurationMinutes == 0 {
		req.MaxDurationMinutes = 90
	}
	if req.DurationStepMinutes == 0 {
		req.DurationStepMinutes = 15
	}
	if req.Category == "" {
		req.Category = "other"
	}

	var emojiPtr *string
	if req.Emoji != "" {
		emojiPtr = &req.Emoji
	}

	var s Service
	err := r.db.QueryRow(ctx,
		`INSERT INTO service_categories (
			name, emoji, bg_color, base_price_cents, display_order, category,
			min_duration_minutes, max_duration_minutes, duration_step_minutes
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, name, description, short_description, emoji, bg_color,
		          base_price_cents, mrp_cents, rating, review_count,
		          min_duration_minutes, max_duration_minutes, duration_step_minutes,
		          is_active, display_order, created_at, category`,
		req.Name, emojiPtr, req.BgColor, req.BasePriceCents,
		req.DisplayOrder, req.Category, req.MinDurationMinutes,
		req.MaxDurationMinutes, req.DurationStepMinutes,
	).Scan(
		&s.ID, &s.Name, &s.Description, &s.ShortDescription, &s.Emoji, &s.BgColor,
		&s.BasePriceCents, &s.MrpCents, &s.Rating, &s.ReviewCount,
		&s.MinDurationMinutes, &s.MaxDurationMinutes, &s.DurationStepMinutes,
		&s.IsActive, &s.DisplayOrder, &s.CreatedAt, &s.Category,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create service: %w", err)
	}
	return &s, nil
}

// Delete permanently removes a service category by ID.
func (r *Repository) Delete(ctx context.Context, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	res, err := r.db.Exec(ctx, `DELETE FROM service_categories WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("failed to delete service: %w", err)
	}
	if res.RowsAffected() == 0 {
		return fmt.Errorf("service not found")
	}
	return nil
}
