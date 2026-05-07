// Package crmconfig loads configuration for the standalone CRM API binary.
// Kept separate from pkg/config so the user-facing API process never pulls in
// CRM-only env vars and vice versa. Reuses the same DATABASE_URL / REDIS_URL
// (shared backend), but owns its own pool sizing, JWT secret, and port.
package crmconfig

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"github.com/rs/zerolog/log"
)

// JWTSecretEntry holds one verification key for JWT validation.
// ID is used as "kid" in JWT headers for deterministic key selection.
// Mirrors pkg/config.JWTSecretEntry — keep in sync.
type JWTSecretEntry struct {
	ID     string
	Secret string
}

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
	JWTSecret            string             // Distinct from user-app JWT_SECRET.
	JWTSecretID          string
	JWTPreviousSecrets   []JWTSecretEntry   // CRM_JWT_PREVIOUS_SECRETS rotation set.
	AccessTokenTTL       time.Duration  // 4h per spec.
	RefreshTokenTTL      time.Duration  // 30d default.
	TOTPIssuer           string
	RefreshCookieDomain  string
	RefreshCookieSecure  bool
	AllowedOrigins       []string
	LockoutThreshold     int            // Failed attempts before lockout.
	LockoutDuration      time.Duration
	AppAPIURL            string         // Base URL of user-facing API for health probe (e.g. https://api.zopmop.com). Empty → probe returns "unknown".
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
		AppAPIURL:           strings.TrimRight(strings.TrimSpace(os.Getenv("APP_API_URL")), "/"),
	}

	prevSecrets, err := parseCRMJWTPreviousSecrets(os.Getenv("CRM_JWT_PREVIOUS_SECRETS"))
	if err != nil {
		return nil, err
	}
	cfg.JWTPreviousSecrets = prevSecrets

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
	if err := validateJWTSecretID(c.JWTSecretID); err != nil {
		return fmt.Errorf("invalid CRM_JWT_SECRET_ID: %w", err)
	}
	if err := validateJWTSecret("CRM_JWT_SECRET", c.JWTSecret); err != nil {
		// In development, weak/blocked secrets are a warning so local
		// dev workflows aren't broken by the placeholder values shipped
		// in .env.example. Production keeps fail-closed semantics.
		if c.IsDevelopment() {
			log.Warn().Err(err).Msg("[crm] weak CRM_JWT_SECRET accepted in development; production will reject this value")
		} else {
			return err
		}
	}
	if c.JWTSecret == os.Getenv("JWT_SECRET") {
		return fmt.Errorf("CRM_JWT_SECRET must be different from user-app JWT_SECRET")
	}

	seenIDs := map[string]struct{}{c.JWTSecretID: {}}
	seenSecrets := map[string]struct{}{c.JWTSecret: {}}
	for _, entry := range c.JWTPreviousSecrets {
		if err := validateJWTSecretID(entry.ID); err != nil {
			return fmt.Errorf("invalid CRM_JWT_PREVIOUS_SECRETS key ID %q: %w", entry.ID, err)
		}
		if err := validateJWTSecret("CRM_JWT_PREVIOUS_SECRETS", entry.Secret); err != nil {
			if c.IsDevelopment() {
				log.Warn().Err(err).Msg("[crm] weak CRM_JWT_PREVIOUS_SECRETS entry accepted in development")
			} else {
				return err
			}
		}
		if _, exists := seenIDs[entry.ID]; exists {
			return fmt.Errorf("duplicate CRM JWT key ID in rotation set: %q", entry.ID)
		}
		if _, exists := seenSecrets[entry.Secret]; exists {
			return fmt.Errorf("duplicate CRM JWT secret found in rotation set")
		}
		seenIDs[entry.ID] = struct{}{}
		seenSecrets[entry.Secret] = struct{}{}
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

// JWTVerificationSecrets returns the active key followed by every
// rotation entry. Issuance always uses the active key; verification
// tries the active key first and falls back through previous keys
// during the rotation window. Mirrors pkg/config.JWTVerificationSecrets.
func (c *Config) JWTVerificationSecrets() []JWTSecretEntry {
	out := make([]JWTSecretEntry, 0, len(c.JWTPreviousSecrets)+1)
	out = append(out, JWTSecretEntry{ID: c.JWTSecretID, Secret: c.JWTSecret})
	out = append(out, c.JWTPreviousSecrets...)
	return out
}

// parseCRMJWTPreviousSecrets parses CRM_JWT_PREVIOUS_SECRETS in the same
// "key_id1:secret1,key_id2:secret2" shape as user-API JWT_PREVIOUS_SECRETS.
// Mirrors parseJWTPreviousSecrets in pkg/config — keep in sync.
func parseCRMJWTPreviousSecrets(raw string) ([]JWTSecretEntry, error) {
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
			return nil, fmt.Errorf("invalid CRM_JWT_PREVIOUS_SECRETS entry %q: expected key_id:secret", part)
		}

		id := strings.TrimSpace(entry[0])
		secret := strings.TrimSpace(entry[1])
		if id == "" || secret == "" {
			return nil, fmt.Errorf("invalid CRM_JWT_PREVIOUS_SECRETS entry %q: key_id and secret are required", part)
		}
		out = append(out, JWTSecretEntry{ID: id, Secret: secret})
	}

	return out, nil
}

// NOTE: validateJWTSecret and validateJWTSecretID below are copied
// verbatim from pkg/config/config.go. Keep these in sync — same
// blocked-substrings list, same length floor, same regex. Long-term
// they should live in a shared pkg/jwtkey/ and be reused, but that
// refactor is deferred (touches user-API config too).

var jwtSecretIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

var blockedJWTSecretSubstrings = []string{
	"change-this-to-a-random-64-char-string-in-production",
	"changeme",
	"change-me",
	"default-secret",
	"jwtsecret",
	"mysecret",
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

	lower := strings.ToLower(secret)
	for _, sub := range blockedJWTSecretSubstrings {
		if strings.Contains(lower, sub) {
			return fmt.Errorf("%s uses a blocked default/insecure value", fieldName)
		}
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
