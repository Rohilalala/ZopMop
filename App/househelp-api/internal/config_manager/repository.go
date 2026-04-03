package config_manager

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Repository handles all database operations for the config_manager module.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new config_manager repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// GetConfig retrieves a single config value by key.
// Falls back to defaults if database returns error (transient availability).
func (r *Repository) GetConfig(ctx context.Context, key string) (string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var value string
	err := r.db.QueryRow(queryCtx,
		`SELECT value FROM app_config WHERE key = $1`,
		key,
	).Scan(&value)
	if err != nil {
		if err == pgx.ErrNoRows {
			// Return default if exists.
			if def, ok := DefaultConfigs[key]; ok {
				return def.Value, nil
			}
			return "", fmt.Errorf("config key not found: %s", key)
		}
		// For database errors, try to use default as fallback.
		// This prevents cascading failures from transient DB issues.
		if def, ok := DefaultConfigs[key]; ok {
			log.Warn().Err(err).Str("key", key).Msg("database error retrieving config, using default")
			return def.Value, nil
		}
		return "", fmt.Errorf("failed to get config: %w", err)
	}

	return value, nil
}

// GetAllConfigs returns all config entries.
func (r *Repository) GetAllConfigs(ctx context.Context) ([]AppConfig, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT key, value, value_type, COALESCE(description, ''),
		        COALESCE(updated_by::text, ''), updated_at::text
		 FROM app_config ORDER BY key`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query configs: %w", err)
	}
	defer rows.Close()

	var configs []AppConfig
	for rows.Next() {
		var c AppConfig
		if err := rows.Scan(&c.Key, &c.Value, &c.ValueType, &c.Description, &c.UpdatedBy, &c.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan config: %w", err)
		}
		configs = append(configs, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating configs: %w", err)
	}

	return configs, nil
}

// SetConfig updates a single config value.
func (r *Repository) SetConfig(ctx context.Context, key, value, updatedBy string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE app_config SET value = $2, updated_by = $3, updated_at = now()
		 WHERE key = $1`,
		key, value, updatedBy,
	)
	if err != nil {
		return fmt.Errorf("failed to set config: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("config key not found: %s", key)
	}

	return nil
}

// BulkSetConfig updates multiple config values in a single transaction.
func (r *Repository) BulkSetConfig(ctx context.Context, configs map[string]string, updatedBy string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := r.db.Begin(queryCtx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() {
		if rbErr := tx.Rollback(queryCtx); rbErr != nil && rbErr != pgx.ErrTxClosed {
			log.Error().Err(rbErr).Msg("failed to rollback transaction")
		}
	}()

	for key, value := range configs {
		result, err := tx.Exec(queryCtx,
			`UPDATE app_config SET value = $2, updated_by = $3, updated_at = now()
			 WHERE key = $1`,
			key, value, updatedBy,
		)
		if err != nil {
			return fmt.Errorf("failed to set config %s: %w", key, err)
		}
		if result.RowsAffected() == 0 {
			return fmt.Errorf("config key not found: %s", key)
		}
	}

	if err := tx.Commit(queryCtx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}
