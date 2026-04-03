package content

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Repository handles all database operations for the content module.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new content repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// GetActiveBanners returns only banners where is_active=true and now() between starts_at and ends_at.
func (r *Repository) GetActiveBanners(ctx context.Context) ([]Banner, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, title, COALESCE(subtitle, ''), image_url, COALESCE(tap_action, ''),
		        display_order, is_active, starts_at, ends_at, created_by, updated_at
		 FROM banners
		 WHERE is_active = true
		   AND (starts_at IS NULL OR starts_at <= now())
		   AND (ends_at IS NULL OR ends_at >= now())
		 ORDER BY display_order ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query active banners: %w", err)
	}
	defer rows.Close()

	var banners []Banner
	for rows.Next() {
		var b Banner
		if err := rows.Scan(&b.ID, &b.Title, &b.Subtitle, &b.ImageURL, &b.TapAction,
			&b.DisplayOrder, &b.IsActive, &b.StartsAt, &b.EndsAt, &b.CreatedBy, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan banner: %w", err)
		}
		banners = append(banners, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating banners: %w", err)
	}

	return banners, nil
}

// GetAllBanners returns all banners including inactive (for admin).
func (r *Repository) GetAllBanners(ctx context.Context) ([]Banner, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, title, COALESCE(subtitle, ''), image_url, COALESCE(tap_action, ''),
		        display_order, is_active, starts_at, ends_at, created_by, updated_at
		 FROM banners ORDER BY display_order ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query all banners: %w", err)
	}
	defer rows.Close()

	var banners []Banner
	for rows.Next() {
		var b Banner
		if err := rows.Scan(&b.ID, &b.Title, &b.Subtitle, &b.ImageURL, &b.TapAction,
			&b.DisplayOrder, &b.IsActive, &b.StartsAt, &b.EndsAt, &b.CreatedBy, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan banner: %w", err)
		}
		banners = append(banners, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating banners: %w", err)
	}

	return banners, nil
}

// GetActiveServiceCategories returns active service categories ordered by display_order.
func (r *Repository) GetActiveServiceCategories(ctx context.Context) ([]ServiceCategory, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, name, COALESCE(description, ''), COALESCE(icon_url, ''),
		        base_price_cents, is_active, display_order, COALESCE(created_by::text, ''), updated_at
		 FROM service_categories
		 WHERE is_active = true
		 ORDER BY display_order ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query active service categories: %w", err)
	}
	defer rows.Close()

	var categories []ServiceCategory
	for rows.Next() {
		var sc ServiceCategory
		if err := rows.Scan(&sc.ID, &sc.Name, &sc.Description, &sc.IconURL,
			&sc.BasePriceCents, &sc.IsActive, &sc.DisplayOrder, &sc.CreatedBy, &sc.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan service category: %w", err)
		}
		categories = append(categories, sc)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating service categories: %w", err)
	}

	return categories, nil
}

// GetAllServiceCategories returns all service categories including inactive (for admin).
func (r *Repository) GetAllServiceCategories(ctx context.Context) ([]ServiceCategory, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, name, COALESCE(description, ''), COALESCE(icon_url, ''),
		        base_price_cents, is_active, display_order, COALESCE(created_by::text, ''), updated_at
		 FROM service_categories
		 ORDER BY display_order ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query all service categories: %w", err)
	}
	defer rows.Close()

	var categories []ServiceCategory
	for rows.Next() {
		var sc ServiceCategory
		if err := rows.Scan(&sc.ID, &sc.Name, &sc.Description, &sc.IconURL,
			&sc.BasePriceCents, &sc.IsActive, &sc.DisplayOrder, &sc.CreatedBy, &sc.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan service category: %w", err)
		}
		categories = append(categories, sc)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating service categories: %w", err)
	}

	return categories, nil
}

// GetScreenContent fetches screen content by screen_key.
func (r *Repository) GetScreenContent(ctx context.Context, screenKey string) (*AppScreen, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	screen := &AppScreen{}
	err := r.db.QueryRow(queryCtx,
		`SELECT id, screen_key, content, is_active, COALESCE(updated_by::text, ''), updated_at
		 FROM app_screens WHERE screen_key = $1 AND is_active = true`,
		screenKey,
	).Scan(&screen.ID, &screen.ScreenKey, &screen.Content,
		&screen.IsActive, &screen.UpdatedBy, &screen.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get screen content: %w", err)
	}

	return screen, nil
}

// GetAllScreenContents returns all screen content entries (for admin).
func (r *Repository) GetAllScreenContents(ctx context.Context) ([]AppScreen, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, screen_key, content, is_active, COALESCE(updated_by::text, ''), updated_at
		 FROM app_screens ORDER BY screen_key`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query all screen contents: %w", err)
	}
	defer rows.Close()

	var screens []AppScreen
	for rows.Next() {
		var s AppScreen
		if err := rows.Scan(&s.ID, &s.ScreenKey, &s.Content, &s.IsActive, &s.UpdatedBy, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan screen: %w", err)
		}
		screens = append(screens, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating screens: %w", err)
	}

	return screens, nil
}

// UpsertBanner creates or updates a banner.
func (r *Repository) UpsertBanner(ctx context.Context, banner *Banner) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if banner.ID == "" {
		// Create.
		err := r.db.QueryRow(queryCtx,
			`INSERT INTO banners (title, subtitle, image_url, tap_action, display_order, is_active, starts_at, ends_at, created_by, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
			 RETURNING id, updated_at`,
			banner.Title, banner.Subtitle, banner.ImageURL, banner.TapAction,
			banner.DisplayOrder, banner.IsActive, banner.StartsAt, banner.EndsAt, banner.CreatedBy,
		).Scan(&banner.ID, &banner.UpdatedAt)
		if err != nil {
			return fmt.Errorf("failed to create banner: %w", err)
		}
	} else {
		// Update.
		result, err := r.db.Exec(queryCtx,
			`UPDATE banners SET title = $2, subtitle = $3, image_url = $4, tap_action = $5,
			        display_order = $6, is_active = $7, starts_at = $8, ends_at = $9, updated_at = now()
			 WHERE id = $1`,
			banner.ID, banner.Title, banner.Subtitle, banner.ImageURL, banner.TapAction,
			banner.DisplayOrder, banner.IsActive, banner.StartsAt, banner.EndsAt,
		)
		if err != nil {
			return fmt.Errorf("failed to update banner: %w", err)
		}
		if result.RowsAffected() == 0 {
			return fmt.Errorf("banner not found")
		}
	}

	return nil
}

// SoftDeleteBanner sets is_active = false for a banner.
func (r *Repository) SoftDeleteBanner(ctx context.Context, bannerID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE banners SET is_active = false, updated_at = now() WHERE id = $1`,
		bannerID,
	)
	if err != nil {
		return fmt.Errorf("failed to soft delete banner: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("banner not found")
	}
	return nil
}

// UpsertServiceCategory creates or updates a service category.
func (r *Repository) UpsertServiceCategory(ctx context.Context, sc *ServiceCategory) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if sc.ID == "" {
		err := r.db.QueryRow(queryCtx,
			`INSERT INTO service_categories (name, description, icon_url, base_price_cents, is_active, display_order, created_by, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, now())
			 RETURNING id, updated_at`,
			sc.Name, sc.Description, sc.IconURL, sc.BasePriceCents,
			sc.IsActive, sc.DisplayOrder, sc.CreatedBy,
		).Scan(&sc.ID, &sc.UpdatedAt)
		if err != nil {
			return fmt.Errorf("failed to create service category: %w", err)
		}
	} else {
		result, err := r.db.Exec(queryCtx,
			`UPDATE service_categories SET name = $2, description = $3, icon_url = $4,
			        base_price_cents = $5, is_active = $6, display_order = $7, updated_at = now()
			 WHERE id = $1`,
			sc.ID, sc.Name, sc.Description, sc.IconURL,
			sc.BasePriceCents, sc.IsActive, sc.DisplayOrder,
		)
		if err != nil {
			return fmt.Errorf("failed to update service category: %w", err)
		}
		if result.RowsAffected() == 0 {
			return fmt.Errorf("service category not found")
		}
	}

	return nil
}

// SoftDeleteServiceCategory sets is_active = false.
func (r *Repository) SoftDeleteServiceCategory(ctx context.Context, categoryID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE service_categories SET is_active = false, updated_at = now() WHERE id = $1`,
		categoryID,
	)
	if err != nil {
		return fmt.Errorf("failed to soft delete service category: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("service category not found")
	}
	return nil
}

// UpsertScreenContent updates screen content by screen_key.
func (r *Repository) UpsertScreenContent(ctx context.Context, screenKey string, content json.RawMessage, updatedBy string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx,
		`INSERT INTO app_screens (screen_key, content, is_active, updated_by, updated_at)
		 VALUES ($1, $2, true, $3, now())
		 ON CONFLICT (screen_key) DO UPDATE SET content = $2, updated_by = $3, updated_at = now()`,
		screenKey, content, updatedBy,
	)
	if err != nil {
		return fmt.Errorf("failed to upsert screen content: %w", err)
	}

	log.Info().Str("screen_key", screenKey).Msg("screen content updated")
	return nil
}

// GetActiveFAQs returns active FAQ items ordered by display_order.
func (r *Repository) GetActiveFAQs(ctx context.Context) ([]FAQItem, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, question, answer, COALESCE(category, ''), display_order, is_active
		 FROM faq_items WHERE is_active = true ORDER BY display_order ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query FAQs: %w", err)
	}
	defer rows.Close()

	var faqs []FAQItem
	for rows.Next() {
		var f FAQItem
		if err := rows.Scan(&f.ID, &f.Question, &f.Answer, &f.Category, &f.DisplayOrder, &f.IsActive); err != nil {
			return nil, fmt.Errorf("failed to scan FAQ: %w", err)
		}
		faqs = append(faqs, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating FAQs: %w", err)
	}

	return faqs, nil
}
