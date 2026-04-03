package database

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// NewRedisClient creates and validates a Redis client connection.
// PoolSize 10, ping with 5s timeout.
func NewRedisClient(ctx context.Context, redisURL string) (*redis.Client, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Redis URL: %w", err)
	}

	opt.PoolSize = 10
	opt.MinIdleConns = 3
	opt.ReadTimeout = 3 * time.Second
	opt.WriteTimeout = 3 * time.Second
	opt.DialTimeout = 5 * time.Second

	client := redis.NewClient(opt)

	// Ping with 5s timeout.
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := client.Ping(pingCtx).Err(); err != nil {
		if closeErr := client.Close(); closeErr != nil {
			log.Error().Err(closeErr).Msg("failed to close Redis client after ping failure")
		}
		return nil, fmt.Errorf("failed to ping Redis: %w", err)
	}

	log.Info().
		Int("pool_size", opt.PoolSize).
		Msg("Redis connection established")

	return client, nil
}
