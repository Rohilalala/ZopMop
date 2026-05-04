package content

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/pkg/database"
)

const (
	contentCacheTTL = 60 * time.Second
	cacheKeyHome    = "content:home"
)

// Service handles content business logic with Redis caching.
type Service struct {
	repo *Repository
	rdb  *redis.Client
}

// NewService creates a new content service.
func NewService(repo *Repository, rdb *redis.Client) *Service {
	return &Service{repo: repo, rdb: rdb}
}

// GetAppHomeContent returns banners + service categories + home screen copy in one response.
// Cached in Redis for 60 seconds.
func (s *Service) GetAppHomeContent(ctx context.Context) (*HomeContentResponse, error) {
	// Try cache first. redis.Nil is a benign miss; other errors mean Redis is
	// down — log a warning and fall through to Postgres so the page still loads.
	cached, err := s.rdb.Get(ctx, cacheKeyHome).Result()
	if err == nil {
		var resp HomeContentResponse
		if jsonErr := json.Unmarshal([]byte(cached), &resp); jsonErr == nil {
			return &resp, nil
		}
		log.Warn().Msg("failed to unmarshal cached home content")
	} else if database.IsRedisDown(err) {
		log.Warn().Err(err).Msg("redis GET failed for home content; falling through to database")
		// Skip the SetNX dance — Redis is down. Go straight to DB without caching.
		return s.fetchAndCacheHomeContent(ctx)
	}

	// Cache miss — use distributed lock to prevent stampede.
	lockKey := cacheKeyHome + ":lock"
	locked, lockErr := s.rdb.SetNX(ctx, lockKey, "1", 5*time.Second).Result()
	if lockErr != nil {
		log.Warn().Err(lockErr).Msg("failed to acquire home content lock, fetching anyway")
	}

	if locked {
		// We got the lock — fetch from DB and populate cache.
		defer s.rdb.Del(ctx, lockKey)
		return s.fetchAndCacheHomeContent(ctx)
	}

	// Another goroutine is fetching — wait briefly and try cache again.
	time.Sleep(100 * time.Millisecond)
	cached, err = s.rdb.Get(ctx, cacheKeyHome).Result()
	if err == nil {
		var resp HomeContentResponse
		if jsonErr := json.Unmarshal([]byte(cached), &resp); jsonErr == nil {
			return &resp, nil
		}
	}

	// Still no cache — fetch directly (don't wait for lock holder).
	return s.fetchAndCacheHomeContent(ctx)
}

// fetchAndCacheHomeContent fetches home content from DB and caches it.
func (s *Service) fetchAndCacheHomeContent(ctx context.Context) (*HomeContentResponse, error) {
	banners, err := s.repo.GetActiveBanners(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get banners: %w", err)
	}
	if banners == nil {
		banners = []Banner{}
	}

	categories, err := s.repo.GetActiveServiceCategories(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get service categories: %w", err)
	}
	if categories == nil {
		categories = []ServiceCategory{}
	}

	screen, err := s.repo.GetScreenContent(ctx, "home")
	if err != nil {
		return nil, fmt.Errorf("failed to get home screen content: %w", err)
	}

	var screenContent json.RawMessage
	if screen != nil {
		screenContent = screen.Content
	} else {
		screenContent = json.RawMessage(`{}`)
	}

	resp := &HomeContentResponse{
		Banners:           banners,
		ServiceCategories: categories,
		Screen:            screenContent,
	}

	// Cache the response.
	respJSON, marshalErr := json.Marshal(resp)
	if marshalErr != nil {
		log.Error().Err(marshalErr).Msg("failed to marshal home content for cache")
	} else {
		if cacheErr := s.rdb.Set(ctx, cacheKeyHome, respJSON, contentCacheTTL).Err(); cacheErr != nil {
			log.Warn().Err(cacheErr).Msg("failed to cache home content")
		}
	}

	return resp, nil
}

// GetScreenContent returns JSONB content for a screen by key.
// Cached in Redis for 60 seconds.
func (s *Service) GetScreenContent(ctx context.Context, key string) (*AppScreen, error) {
	cacheKey := fmt.Sprintf("content:screen:%s", key)

	// Try cache. redis.Nil is a benign miss; other errors mean Redis is down.
	cached, err := s.rdb.Get(ctx, cacheKey).Result()
	if err == nil {
		var screen AppScreen
		if jsonErr := json.Unmarshal([]byte(cached), &screen); jsonErr == nil {
			return &screen, nil
		}
		log.Warn().Str("key", key).Msg("failed to unmarshal cached screen content")
	} else if database.IsRedisDown(err) {
		log.Warn().Err(err).Str("key", key).Msg("redis GET failed for screen content; falling through to database")
	}

	// Cache miss.
	screen, err := s.repo.GetScreenContent(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("failed to get screen content: %w", err)
	}
	if screen == nil {
		return nil, nil
	}

	// Cache.
	screenJSON, marshalErr := json.Marshal(screen)
	if marshalErr != nil {
		log.Error().Err(marshalErr).Msg("failed to marshal screen content for cache")
	} else {
		if cacheErr := s.rdb.Set(ctx, cacheKey, screenJSON, contentCacheTTL).Err(); cacheErr != nil {
			log.Warn().Err(cacheErr).Msg("failed to cache screen content")
		}
	}

	return screen, nil
}

// InvalidateContentCache removes all content cache keys.
// Called by admin after any content update.
func (s *Service) InvalidateContentCache(ctx context.Context) {
	// Delete known cache keys.
	keys := []string{cacheKeyHome}

	// Also scan for screen-specific caches.
	iter := s.rdb.Scan(ctx, 0, "content:screen:*", 100).Iterator()
	for iter.Next(ctx) {
		keys = append(keys, iter.Val())
	}
	if err := iter.Err(); err != nil {
		log.Error().Err(err).Msg("failed to scan content cache keys")
	}

	if len(keys) > 0 {
		if err := s.rdb.Del(ctx, keys...).Err(); err != nil {
			log.Error().Err(err).Msg("failed to invalidate content cache")
		} else {
			log.Info().Int("keys_deleted", len(keys)).Msg("content cache invalidated")
		}
	}
}

// GetActiveServices returns active service categories.
func (s *Service) GetActiveServices(ctx context.Context) ([]ServiceCategory, error) {
	categories, err := s.repo.GetActiveServiceCategories(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get active services: %w", err)
	}
	if categories == nil {
		categories = []ServiceCategory{}
	}
	return categories, nil
}

// GetActiveFAQs returns active FAQ items.
func (s *Service) GetActiveFAQs(ctx context.Context) ([]FAQItem, error) {
	faqs, err := s.repo.GetActiveFAQs(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get FAQs: %w", err)
	}
	if faqs == nil {
		faqs = []FAQItem{}
	}
	return faqs, nil
}

// --- Admin content operations ---

// GetAllBanners returns all banners including inactive (admin).
func (s *Service) GetAllBanners(ctx context.Context) ([]Banner, error) {
	return s.repo.GetAllBanners(ctx)
}

// CreateBanner creates a new banner and invalidates cache.
func (s *Service) CreateBanner(ctx context.Context, banner *Banner) error {
	if err := s.repo.UpsertBanner(ctx, banner); err != nil {
		return err
	}
	s.InvalidateContentCache(ctx)
	return nil
}

// UpdateBanner updates a banner and invalidates cache.
func (s *Service) UpdateBanner(ctx context.Context, banner *Banner) error {
	if err := s.repo.UpsertBanner(ctx, banner); err != nil {
		return err
	}
	s.InvalidateContentCache(ctx)
	return nil
}

// DeleteBanner soft-deletes a banner and invalidates cache.
func (s *Service) DeleteBanner(ctx context.Context, bannerID string) error {
	if err := s.repo.SoftDeleteBanner(ctx, bannerID); err != nil {
		return err
	}
	s.InvalidateContentCache(ctx)
	return nil
}

// GetAllServiceCategories returns all service categories including inactive (admin).
func (s *Service) GetAllServiceCategories(ctx context.Context) ([]ServiceCategory, error) {
	return s.repo.GetAllServiceCategories(ctx)
}

// CreateServiceCategory creates a new service category and invalidates cache.
func (s *Service) CreateServiceCategory(ctx context.Context, sc *ServiceCategory) error {
	if err := s.repo.UpsertServiceCategory(ctx, sc); err != nil {
		return err
	}
	s.InvalidateContentCache(ctx)
	return nil
}

// UpdateServiceCategory updates a service category and invalidates cache.
func (s *Service) UpdateServiceCategory(ctx context.Context, sc *ServiceCategory) error {
	if err := s.repo.UpsertServiceCategory(ctx, sc); err != nil {
		return err
	}
	s.InvalidateContentCache(ctx)
	return nil
}

// DeleteServiceCategory soft-deletes a service category and invalidates cache.
func (s *Service) DeleteServiceCategory(ctx context.Context, categoryID string) error {
	if err := s.repo.SoftDeleteServiceCategory(ctx, categoryID); err != nil {
		return err
	}
	s.InvalidateContentCache(ctx)
	return nil
}

// GetAllScreenContents returns all screen content entries (admin).
func (s *Service) GetAllScreenContents(ctx context.Context) ([]AppScreen, error) {
	return s.repo.GetAllScreenContents(ctx)
}

// UpdateScreenContent updates screen content by key and invalidates cache.
func (s *Service) UpdateScreenContent(ctx context.Context, screenKey string, content json.RawMessage, updatedBy string) error {
	if err := s.repo.UpsertScreenContent(ctx, screenKey, content, updatedBy); err != nil {
		return err
	}
	s.InvalidateContentCache(ctx)
	return nil
}
