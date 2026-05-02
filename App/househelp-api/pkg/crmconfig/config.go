// Package crmconfig loads configuration for the standalone CRM API binary.
// Kept separate from pkg/config so the user-facing API process never pulls in
// CRM-only env vars and vice versa. Reuses the same DATABASE_URL / REDIS_URL
// (shared backend), but owns its own pool sizing, JWT secret, and port.
package crmconfig

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"github.com/rs/zerolog/log"
)

// Config is the runtime configuration of the CRM API service.
type Config struct {
	Port                 string
	Env                  string
	DatabaseURL          string         // Primary (read-write) DSN — same instance as user app.
	DatabaseReadURL      string         // Optional read-replica DSN; falls back to DatabaseURL.
	RedisURL             string
	RedisNamespace       string         // Key prefix to isolate from user app (default "crm:").
	DBPoolMinConns       int32
	DBPoolMaxConns       int32          // Capped low (CRM has few admins) so we never starve user-app pool.
	DBPoolMaxConnLife    time.Duration
	DBPoolMaxConnIdle    time.Duration
	DBPoolHealthCheck    time.Duration
	JWTSecret            string         // Distinct from user-app JWT_SECRET.
	JWTSecretID          string
	AccessTokenTTL       time.Duration  // 4h per spec.
	RefreshTokenTTL      time.Duration  // 30d default.
	TOTPIssuer           string
	RefreshCookieDomain  string
	RefreshCookieSecure  bool
	AllowedOrigins       []string
	LockoutThreshold     int            // Failed attempts before lockout.
	LockoutDuration      time.Duration
}

// IsDevelopment reports whether the service is running in dev mode.
func (c *Config) IsDevelopment() bool { return c.Env == "development" }

// IsProduction reports whether the service is running in production mode.
func (c *Config) IsProduction() bool { return c.Env == "production" }

// Load reads CRM env vars and validates them.
func Load() (*Config, error) {
	if err := godotenv.Load(); err != nil {
		log.Warn().Msg("[crm] no .env file found, reading from environment")
	}

	cfg := &Config{
		Port:                getEnvOr("CRM_API_PORT", "8090"),
		Env:                 getEnvOr("ENV", "production"),
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		DatabaseReadURL:     os.Getenv("CRM_DATABASE_READ_URL"),
		RedisURL:            os.Getenv("REDIS_URL"),
		RedisNamespace:      getEnvOr("CRM_REDIS_NAMESPACE", "crm:"),
		DBPoolMinConns:      int32(getEnvInt("CRM_DB_POOL_MIN_CONNS", 2)),
		DBPoolMaxConns:      int32(getEnvInt("CRM_DB_POOL_MAX_CONNS", 15)),
		DBPoolMaxConnLife:   time.Duration(getEnvInt("CRM_DB_POOL_MAX_CONN_LIFETIME_MINUTES", 20)) * time.Minute,
		DBPoolMaxConnIdle:   time.Duration(getEnvInt("CRM_DB_POOL_MAX_CONN_IDLE_MINUTES", 5)) * time.Minute,
		DBPoolHealthCheck:   time.Duration(getEnvInt("CRM_DB_POOL_HEALTHCHECK_SECONDS", 60)) * time.Second,
		JWTSecret:           strings.TrimSpace(os.Getenv("CRM_JWT_SECRET")),
		JWTSecretID:         getEnvOr("CRM_JWT_SECRET_ID", "crm-active"),
		AccessTokenTTL:      time.Duration(getEnvInt("CRM_ACCESS_TOKEN_TTL_MINUTES", 240)) * time.Minute,
		RefreshTokenTTL:     time.Duration(getEnvInt("CRM_REFRESH_TOKEN_TTL_HOURS", 24*30)) * time.Hour,
		TOTPIssuer:          getEnvOr("CRM_TOTP_ISSUER", "Zopmop CRM"),
		RefreshCookieDomain: os.Getenv("CRM_REFRESH_COOKIE_DOMAIN"),
		RefreshCookieSecure: getEnvBool("CRM_REFRESH_COOKIE_SECURE", true),
		LockoutThreshold:    getEnvInt("CRM_LOCKOUT_THRESHOLD", 5),
		LockoutDuration:     time.Duration(getEnvInt("CRM_LOCKOUT_DURATION_MINUTES", 15)) * time.Minute,
	}

	if origins := strings.TrimSpace(os.Getenv("CRM_ALLOWED_ORIGINS")); origins != "" {
		for _, o := range strings.Split(origins, ",") {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, strings.TrimSpace(o))
		}
	}

	if cfg.DatabaseReadURL == "" {
		cfg.DatabaseReadURL = cfg.DatabaseURL
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) validate() error {
	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	if c.RedisURL == "" {
		return fmt.Errorf("REDIS_URL is required")
	}
	if c.JWTSecret == "" {
		return fmt.Errorf("CRM_JWT_SECRET is required")
	}
	if len(c.JWTSecret) < 64 {
		return fmt.Errorf("CRM_JWT_SECRET must be at least 64 characters")
	}
	if c.JWTSecret == os.Getenv("JWT_SECRET") {
		return fmt.Errorf("CRM_JWT_SECRET must be different from user-app JWT_SECRET")
	}
	if c.DBPoolMaxConns <= 0 {
		return fmt.Errorf("CRM_DB_POOL_MAX_CONNS must be positive")
	}
	if c.DBPoolMaxConns > 30 {
		log.Warn().Int32("max", c.DBPoolMaxConns).Msg("[crm] DB pool max is unusually high — risk of starving user-app pool")
	}
	if c.LockoutThreshold < 1 {
		return fmt.Errorf("CRM_LOCKOUT_THRESHOLD must be >= 1")
	}
	if !strings.HasSuffix(c.RedisNamespace, ":") {
		c.RedisNamespace += ":"
	}
	return nil
}

func getEnvOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return v
}

func getEnvBool(key string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if raw == "" {
		return fallback
	}
	return raw == "1" || raw == "true" || raw == "yes"
}
