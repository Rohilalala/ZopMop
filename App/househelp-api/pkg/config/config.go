package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
	"github.com/rs/zerolog/log"
)

// Config holds all application configuration values.
// Secrets are never logged or serialized.
type Config struct {
	Port           string
	Env            string
	DatabaseURL    string
	RedisURL       string
	JWTSecret      string
	JWTExpiryHours int
	AllowedOrigins []string
}

// IsDevelopment returns true when running in development mode.
func (c *Config) IsDevelopment() bool {
	return c.Env == "development"
}

// IsProduction returns true when running in production mode.
func (c *Config) IsProduction() bool {
	return c.Env == "production"
}

// Load reads configuration from environment variables.
// In development mode it loads from .env first.
// It validates that all required fields are present.
func Load() (*Config, error) {
	// Attempt to load .env; not an error if missing in production.
	if err := godotenv.Load(); err != nil {
		log.Warn().Msg("No .env file found, reading from environment")
	}

	cfg := &Config{
		Port:        getEnvOrDefault("PORT", "8080"),
		Env:         getEnvOrDefault("ENV", "development"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisURL:    os.Getenv("REDIS_URL"),
		JWTSecret:   os.Getenv("JWT_SECRET"),
	}

	// Parse JWT expiry hours.
	expiryStr := getEnvOrDefault("JWT_EXPIRY_HOURS", "24")
	expiry, err := strconv.Atoi(expiryStr)
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_EXPIRY_HOURS value %q: %w", expiryStr, err)
	}
	cfg.JWTExpiryHours = expiry

	// Parse allowed origins.
	originsStr := getEnvOrDefault("ALLOWED_ORIGINS", "")
	if originsStr != "" {
		cfg.AllowedOrigins = strings.Split(originsStr, ",")
		for i, origin := range cfg.AllowedOrigins {
			cfg.AllowedOrigins[i] = strings.TrimSpace(origin)
		}
	}

	// Validate required fields. Never log the actual values of secrets.
	if err := cfg.validate(); err != nil {
		return nil, err
	}

	return cfg, nil
}

// validate checks that all required configuration values are set.
func (c *Config) validate() error {
	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	if c.RedisURL == "" {
		return fmt.Errorf("REDIS_URL is required")
	}
	if c.JWTSecret == "" {
		return fmt.Errorf("JWT_SECRET is required")
	}
	if len(c.JWTSecret) < 32 {
		return fmt.Errorf("JWT_SECRET must be at least 32 characters")
	}
	if c.JWTExpiryHours <= 0 {
		return fmt.Errorf("JWT_EXPIRY_HOURS must be positive")
	}
	return nil
}

// getEnvOrDefault returns the environment variable value or a fallback.
func getEnvOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
