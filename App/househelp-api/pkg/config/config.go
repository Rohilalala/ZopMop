package config

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
	"github.com/rs/zerolog/log"
)

// Config holds all application configuration values.
// Secrets are never logged or serialized.
type Config struct {
	Port               string
	Env                string
	DatabaseURL        string
	RedisURL           string
	DBPoolMinConns     int32
	DBPoolMaxConns     int32
	DBPoolMaxConnLife  int
	DBPoolMaxConnIdle  int
	DBPoolHealthCheck  int
	DBBoundMaxInFlight int
	DBBoundQueueWaitMS int
	JWTSecret          string
	JWTSecretID        string
	JWTPreviousSecrets []JWTSecretEntry
	JWTExpiryHours     int
	AllowedOrigins     []string
}

// JWTSecretEntry holds one verification key for JWT validation.
// ID is used as "kid" in JWT headers for deterministic key selection.
type JWTSecretEntry struct {
	ID     string
	Secret string
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
		Port:               getEnvOrDefault("PORT", "8080"),
		Env:                getEnvOrDefault("ENV", "production"),
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		RedisURL:           os.Getenv("REDIS_URL"),
		DBPoolMinConns:     int32(getEnvIntOrDefault("DB_POOL_MIN_CONNS", 20)),
		DBPoolMaxConns:     int32(getEnvIntOrDefault("DB_POOL_MAX_CONNS", 80)),
		DBPoolMaxConnLife:  getEnvIntOrDefault("DB_POOL_MAX_CONN_LIFETIME_MINUTES", 20),
		DBPoolMaxConnIdle:  getEnvIntOrDefault("DB_POOL_MAX_CONN_IDLE_MINUTES", 5),
		DBPoolHealthCheck:  getEnvIntOrDefault("DB_POOL_HEALTHCHECK_SECONDS", 60),
		DBBoundMaxInFlight: getEnvIntOrDefault("DB_BOUND_MAX_INFLIGHT", 600),
		DBBoundQueueWaitMS: getEnvIntOrDefault("DB_BOUND_QUEUE_WAIT_MS", 75),
		JWTSecret:          strings.TrimSpace(os.Getenv("JWT_SECRET")),
		JWTSecretID:        strings.TrimSpace(getEnvOrDefault("JWT_SECRET_ID", "active")),
	}

	prevSecrets, err := parseJWTPreviousSecrets(os.Getenv("JWT_PREVIOUS_SECRETS"))
	if err != nil {
		return nil, err
	}
	cfg.JWTPreviousSecrets = prevSecrets

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
	if err := validateJWTSecretID(c.JWTSecretID); err != nil {
		return fmt.Errorf("invalid JWT_SECRET_ID: %w", err)
	}
	if err := validateJWTSecret("JWT_SECRET", c.JWTSecret); err != nil {
		return err
	}

	seenIDs := map[string]struct{}{c.JWTSecretID: {}}
	seenSecrets := map[string]struct{}{c.JWTSecret: {}}
	for _, entry := range c.JWTPreviousSecrets {
		if err := validateJWTSecretID(entry.ID); err != nil {
			return fmt.Errorf("invalid JWT_PREVIOUS_SECRETS key ID %q: %w", entry.ID, err)
		}
		if err := validateJWTSecret("JWT_PREVIOUS_SECRETS", entry.Secret); err != nil {
			return err
		}
		if _, exists := seenIDs[entry.ID]; exists {
			return fmt.Errorf("duplicate JWT key ID in rotation set: %q", entry.ID)
		}
		if _, exists := seenSecrets[entry.Secret]; exists {
			return fmt.Errorf("duplicate JWT secret found in rotation set")
		}
		seenIDs[entry.ID] = struct{}{}
		seenSecrets[entry.Secret] = struct{}{}
	}
	if c.JWTExpiryHours <= 0 {
		return fmt.Errorf("JWT_EXPIRY_HOURS must be positive")
	}
	if c.DBPoolMinConns < 0 {
		return fmt.Errorf("DB_POOL_MIN_CONNS must be non-negative")
	}
	if c.DBPoolMaxConns <= 0 {
		return fmt.Errorf("DB_POOL_MAX_CONNS must be positive")
	}
	if c.DBPoolMinConns > c.DBPoolMaxConns {
		return fmt.Errorf("DB_POOL_MIN_CONNS cannot exceed DB_POOL_MAX_CONNS")
	}
	if c.DBPoolMaxConnLife <= 0 {
		return fmt.Errorf("DB_POOL_MAX_CONN_LIFETIME_MINUTES must be positive")
	}
	if c.DBPoolMaxConnIdle <= 0 {
		return fmt.Errorf("DB_POOL_MAX_CONN_IDLE_MINUTES must be positive")
	}
	if c.DBPoolHealthCheck <= 0 {
		return fmt.Errorf("DB_POOL_HEALTHCHECK_SECONDS must be positive")
	}
	if c.DBBoundMaxInFlight <= 0 {
		return fmt.Errorf("DB_BOUND_MAX_INFLIGHT must be positive")
	}
	if c.DBBoundQueueWaitMS <= 0 {
		return fmt.Errorf("DB_BOUND_QUEUE_WAIT_MS must be positive")
	}
	return nil
}

// JWTVerificationSecrets returns active + previous JWT keys for verification.
func (c *Config) JWTVerificationSecrets() []JWTSecretEntry {
	out := make([]JWTSecretEntry, 0, len(c.JWTPreviousSecrets)+1)
	out = append(out, JWTSecretEntry{
		ID:     c.JWTSecretID,
		Secret: c.JWTSecret,
	})
	out = append(out, c.JWTPreviousSecrets...)
	return out
}

var jwtSecretIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

var blockedJWTSecrets = map[string]struct{}{
	"change-this-to-a-random-64-char-string-in-production": {},
	"changeme":       {},
	"change-me":      {},
	"default":        {},
	"default-secret": {},
	"jwtsecret":      {},
	"mysecret":       {},
	"password":       {},
	"secret":         {},
}

func validateJWTSecretID(id string) error {
	if !jwtSecretIDPattern.MatchString(strings.TrimSpace(id)) {
		return fmt.Errorf("must match %q", jwtSecretIDPattern.String())
	}
	return nil
}

func validateJWTSecret(fieldName, secret string) error {
	trimmed := strings.TrimSpace(secret)
	if trimmed != secret {
		return fmt.Errorf("%s must not contain leading/trailing whitespace", fieldName)
	}
	if len(secret) < 64 {
		return fmt.Errorf("%s must be at least 64 characters", fieldName)
	}

	if _, blocked := blockedJWTSecrets[strings.ToLower(secret)]; blocked {
		return fmt.Errorf("%s uses a blocked default/insecure value", fieldName)
	}

	uniqueChars := make(map[rune]struct{}, len(secret))
	for _, r := range secret {
		if r < 33 || r > 126 {
			return fmt.Errorf("%s must use visible ASCII characters only", fieldName)
		}
		uniqueChars[r] = struct{}{}
	}
	if len(uniqueChars) < 10 {
		return fmt.Errorf("%s appears weak (too few unique characters)", fieldName)
	}

	return nil
}

func parseJWTPreviousSecrets(raw string) ([]JWTSecretEntry, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	parts := strings.Split(raw, ",")
	out := make([]JWTSecretEntry, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		entry := strings.SplitN(part, ":", 2)
		if len(entry) != 2 {
			return nil, fmt.Errorf("invalid JWT_PREVIOUS_SECRETS entry %q: expected key_id:secret", part)
		}

		id := strings.TrimSpace(entry[0])
		secret := strings.TrimSpace(entry[1])
		if id == "" || secret == "" {
			return nil, fmt.Errorf("invalid JWT_PREVIOUS_SECRETS entry %q: key_id and secret are required", part)
		}
		out = append(out, JWTSecretEntry{ID: id, Secret: secret})
	}

	return out, nil
}

// getEnvOrDefault returns the environment variable value or a fallback.
func getEnvOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getEnvIntOrDefault(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}
