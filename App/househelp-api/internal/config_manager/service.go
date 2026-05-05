package config_manager

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/pkg/database"
)

const configCacheTTL = 5 * time.Minute

// Service handles config_manager business logic with Redis caching.
type Service struct {
	repo *Repository
	rdb  *redis.Client
}

// NewService creates a new config_manager service.
func NewService(repo *Repository, rdb *redis.Client) *Service {
	return &Service{repo: repo, rdb: rdb}
}

// GetConfig fetches a config value from Redis cache first, falls back to Postgres.
// Caches for 5 minutes.
func (s *Service) GetConfig(ctx context.Context, key string) (string, error) {
	cacheKey := fmt.Sprintf("cfg:%s", key)

	// Try cache. redis.Nil is a benign miss; any other error means Redis is
	// down — log a warning and fall through to Postgres rather than aborting.
	cached, err := s.rdb.Get(ctx, cacheKey).Result()
	if err == nil {
		return cached, nil
	}
	if database.IsRedisDown(err) {
		log.Warn().Err(err).Str("key", key).Msg("redis GET failed; falling through to database")
	}

	// Cache miss — fetch from database.
	value, err := s.repo.GetConfig(ctx, key)
	if err != nil {
		return "", err
	}

	// Cache the value.
	if cacheErr := s.rdb.Set(ctx, cacheKey, value, configCacheTTL).Err(); cacheErr != nil {
		log.Warn().Err(cacheErr).Str("key", key).Msg("failed to cache config value")
	}

	return value, nil
}

// SetConfig updates a config value, invalidates Redis cache, and logs the admin action.
func (s *Service) SetConfig(ctx context.Context, key, value, adminID string) error {
	if err := s.repo.SetConfig(ctx, key, value, adminID); err != nil {
		return err
	}

	// Invalidate cache.
	cacheKey := fmt.Sprintf("cfg:%s", key)
	if err := s.rdb.Del(ctx, cacheKey).Err(); err != nil {
		log.Warn().Err(err).Str("key", key).Msg("failed to invalidate config cache")
	}

	log.Info().Str("key", key).Str("admin_id", adminID).Msg("config updated")
	return nil
}

// BulkSetConfig updates multiple config values and invalidates all their caches.
func (s *Service) BulkSetConfig(ctx context.Context, configs map[string]string, adminID string) error {
	if err := s.repo.BulkSetConfig(ctx, configs, adminID); err != nil {
		return err
	}

	// Invalidate caches.
	var cacheKeys []string
	for key := range configs {
		cacheKeys = append(cacheKeys, fmt.Sprintf("cfg:%s", key))
	}
	if len(cacheKeys) > 0 {
		if err := s.rdb.Del(ctx, cacheKeys...).Err(); err != nil {
			log.Warn().Err(err).Msg("failed to invalidate config caches")
		}
	}

	log.Info().Int("count", len(configs)).Str("admin_id", adminID).Msg("bulk config updated")
	return nil
}

// GetPublicConfig returns only safe-to-expose keys for the app.
func (s *Service) GetPublicConfig(ctx context.Context) (map[string]string, error) {
	result := make(map[string]string)

	for _, key := range PublicConfigKeys {
		value, err := s.GetConfig(ctx, key)
		if err != nil {
			log.Warn().Err(err).Str("key", key).Msg("failed to get public config value")
			// Use default if available.
			if def, ok := DefaultConfigs[key]; ok {
				value = def.Value
			} else {
				continue
			}
		}
		result[key] = value
	}

	return result, nil
}

// GetMatchingConfig returns matching parameters for the matching engine.
// Falls back to defaults for any value that fails to parse.
func (s *Service) GetMatchingConfig(ctx context.Context) (*MatchingConfig, error) {
	cfg := &MatchingConfig{
		MaxWalkMinutes:     DefaultConfigs[ConfigMatchingMaxWalkMinutes].toInt(),
		TimeoutSeconds:     DefaultConfigs[ConfigMatchingTimeoutSeconds].toInt(),
		MaxHelpersNotified: DefaultConfigs[ConfigMatchingMaxHelpersNotified].toInt(),
	}

	if v, err := s.GetConfig(ctx, ConfigMatchingMaxWalkMinutes); err == nil {
		if i, err := strconv.Atoi(v); err == nil {
			// Walking budget should be positive and within a sane band (1..120
			// min). Anything outside that suggests a misconfigured admin tool.
			if i > 0 && i <= 120 {
				cfg.MaxWalkMinutes = i
			} else {
				log.Warn().Int("value", i).Str("key", ConfigMatchingMaxWalkMinutes).Msg("walk budget out of bounds, using default")
			}
		} else {
			log.Warn().Str("key", ConfigMatchingMaxWalkMinutes).Str("value", v).Msg("invalid config value, using default")
		}
	} else {
		log.Warn().Err(err).Msg("failed to get matching walk budget config, using default")
	}

	if v, err := s.GetConfig(ctx, ConfigMatchingTimeoutSeconds); err == nil {
		if i, err := strconv.Atoi(v); err == nil {
			// Validate bounds: timeout should be positive and reasonable (1 to 300 seconds)
			if i > 0 && i <= 300 {
				cfg.TimeoutSeconds = i
			} else {
				log.Warn().Int("value", i).Str("key", ConfigMatchingTimeoutSeconds).Msg("timeout out of bounds, using default")
			}
		} else {
			log.Warn().Str("key", ConfigMatchingTimeoutSeconds).Str("value", v).Msg("invalid config value, using default")
		}
	} else {
		log.Warn().Err(err).Msg("failed to get matching timeout config, using default")
	}

	if v, err := s.GetConfig(ctx, ConfigMatchingMaxHelpersNotified); err == nil {
		if i, err := strconv.Atoi(v); err == nil {
			// Validate bounds: max helpers should be positive and reasonable (1 to 50)
			if i > 0 && i <= 50 {
				cfg.MaxHelpersNotified = i
			} else {
				log.Warn().Int("value", i).Str("key", ConfigMatchingMaxHelpersNotified).Msg("max helpers out of bounds, using default")
			}
		} else {
			log.Warn().Str("key", ConfigMatchingMaxHelpersNotified).Str("value", v).Msg("invalid config value, using default")
		}
	} else {
		log.Warn().Err(err).Msg("failed to get max helpers notified config, using default")
	}

	return cfg, nil
}

// GetPricingConfig returns pricing parameters for the booking service.
func (s *Service) GetPricingConfig(ctx context.Context) (*PricingConfig, error) {
	baseFeeStr, err := s.GetConfig(ctx, ConfigPricingBaseFeeCents)
	if err != nil {
		return nil, fmt.Errorf("failed to get base fee: %w", err)
	}
	baseFee, parseErr := strconv.Atoi(baseFeeStr)
	if parseErr != nil {
		return nil, fmt.Errorf("invalid base fee value: %w", parseErr)
	}

	surgeStr, err := s.GetConfig(ctx, ConfigPricingSurgeMultiplier)
	if err != nil {
		return nil, fmt.Errorf("failed to get surge multiplier: %w", err)
	}
	surge, parseErr := strconv.ParseFloat(surgeStr, 64)
	if parseErr != nil {
		return nil, fmt.Errorf("invalid surge multiplier value: %w", parseErr)
	}

	surgeEnabledStr, err := s.GetConfig(ctx, ConfigPricingSurgeEnabled)
	if err != nil {
		return nil, fmt.Errorf("failed to get surge enabled: %w", err)
	}
	surgeEnabled := surgeEnabledStr == "true"

	return &PricingConfig{
		BaseFeeCents:    baseFee,
		SurgeMultiplier: surge,
		SurgeEnabled:    surgeEnabled,
	}, nil
}

// GetAllConfigs returns all config entries (for admin panel).
func (s *Service) GetAllConfigs(ctx context.Context) ([]AppConfig, error) {
	configs, err := s.repo.GetAllConfigs(ctx)
	if err != nil {
		return nil, err
	}

	// ensure we never return nil
	if configs == nil {
		configs = []AppConfig{}
	}

	return configs, nil
}

// LogConfigChange logs a config change to the audit log via admin repository.
// This is a helper that callers can use to record changes.
func (s *Service) LogConfigChange(ctx context.Context, adminID, key, oldValue, newValue string) {
	oldJSON, _ := json.Marshal(map[string]string{"value": oldValue})
	newJSON, _ := json.Marshal(map[string]string{"value": newValue})
	log.Info().
		Str("admin_id", adminID).
		Str("key", key).
		RawJSON("old_value", oldJSON).
		RawJSON("new_value", newJSON).
		Msg("config changed")
}
