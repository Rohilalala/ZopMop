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

	// Post-Firebase OTP auth. Distinct from the legacy JWT_SECRET used
	// by the Firebase exchange — JWTAccessSecret signs short-lived
	// access tokens, JWTRefreshSecret is reserved for future symmetric
	// tagging of refresh-token records. Refresh tokens themselves are
	// random opaque strings; JWTRefreshSecret is kept distinct so a
	// compromised access secret cannot forge refresh material.
	JWTAccessSecret   string
	JWTRefreshSecret  string
	JWTAccessTTLHours int
	JWTRefreshTTLDays int

	// Message Central VerifyNow OTP gateway. CustomerID + AuthToken
	// are required in production; OTPDevMode bypasses all network
	// calls and treats the hardcoded OTP "999999" as valid for every
	// phone.
	MessageCentralCustomerID string
	MessageCentralAuthToken  string
	MessageCentralBaseURL    string
	OTPDevMode               bool
	AllowedOrigins           []string
	WebhookAllowedDomains    []string // ALLOWED_WEBHOOK_DOMAINS; empty = any non-private domain allowed

	// Cashfree Payment Gateway (collection). Distinct from Cashfree Payouts
	// (CASHFREE_CLIENT_ID/SECRET) used for VPA validation in internal/payments.
	// All four values are required as a set when CashfreePGAppID is set;
	// leave all empty to disable PG and fall back to the manual gateway.
	CashfreePGAppID         string
	CashfreePGSecretKey     string
	CashfreePGEnv           string // "sandbox" | "production"
	CashfreePGWebhookSecret string

	// PublicBaseURL is the fully-qualified base URL of this API as reachable
	// from the public internet — used to build webhook callback URLs that
	// gateways register with. Examples:
	//   sandbox/local: https://abc123.ngrok-free.app
	//   production:    https://api.zopmop.com
	// Required when CashfreePGAppID is set. Trailing slash stripped on load.
	PublicBaseURL string
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
		Env:                getEnvOrDefault("APP_ENV", getEnvOrDefault("ENV", "production")),
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

	cfg.JWTAccessSecret = strings.TrimSpace(os.Getenv("JWT_ACCESS_SECRET"))
	if cfg.JWTAccessSecret == "" {
		// Fall back to the legacy JWT_SECRET so a single-secret deploy
		// keeps working. The validator below treats this as the
		// signing secret for the new OTP access tokens.
		cfg.JWTAccessSecret = cfg.JWTSecret
	}
	cfg.JWTRefreshSecret = strings.TrimSpace(os.Getenv("JWT_REFRESH_SECRET"))
	cfg.JWTAccessTTLHours = getEnvIntOrDefault("JWT_ACCESS_TTL_HOURS", 1)
	cfg.JWTRefreshTTLDays = getEnvIntOrDefault("JWT_REFRESH_TTL_DAYS", 30)

	cfg.MessageCentralCustomerID = strings.TrimSpace(os.Getenv("MESSAGECENTRAL_CUSTOMER_ID"))
	cfg.MessageCentralAuthToken = strings.TrimSpace(os.Getenv("MESSAGECENTRAL_AUTH_TOKEN"))
	cfg.MessageCentralBaseURL = strings.TrimRight(strings.TrimSpace(os.Getenv("MESSAGECENTRAL_BASE_URL")), "/")
	if cfg.MessageCentralBaseURL == "" {
		cfg.MessageCentralBaseURL = "https://cpaas.messagecentral.com"
	}
	cfg.OTPDevMode = strings.EqualFold(strings.TrimSpace(os.Getenv("OTP_DEV_MODE")), "true")

	cfg.CashfreePGAppID = strings.TrimSpace(os.Getenv("CASHFREE_PG_APP_ID"))
	cfg.CashfreePGSecretKey = strings.TrimSpace(os.Getenv("CASHFREE_PG_SECRET_KEY"))
	cfg.CashfreePGEnv = strings.ToLower(strings.TrimSpace(os.Getenv("CASHFREE_PG_ENV")))
	cfg.CashfreePGWebhookSecret = strings.TrimSpace(os.Getenv("CASHFREE_PG_WEBHOOK_SECRET"))
	// Default webhook secret to the API secret when not overridden. Cashfree
	// signs webhooks with the same secret unless a separate one is configured
	// in the merchant dashboard for rotation.
	if cfg.CashfreePGAppID != "" && cfg.CashfreePGWebhookSecret == "" {
		cfg.CashfreePGWebhookSecret = cfg.CashfreePGSecretKey
	}

	cfg.PublicBaseURL = strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")), "/")

	// Parse allowed origins.
	originsStr := getEnvOrDefault("ALLOWED_ORIGINS", "")
	if originsStr != "" {
		cfg.AllowedOrigins = strings.Split(originsStr, ",")
		for i, origin := range cfg.AllowedOrigins {
			cfg.AllowedOrigins[i] = strings.TrimSpace(origin)
		}
	}

	// Parse webhook allowlist (comma-separated domains, e.g. "api.slack.com,hooks.example.com").
	webhookDomainsStr := strings.TrimSpace(os.Getenv("ALLOWED_WEBHOOK_DOMAINS"))
	if webhookDomainsStr != "" {
		parts := strings.Split(webhookDomainsStr, ",")
		for _, p := range parts {
			if d := strings.TrimSpace(p); d != "" {
				cfg.WebhookAllowedDomains = append(cfg.WebhookAllowedDomains, d)
			}
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
		// In development, weak/blocked secrets are a warning so local dev
		// workflows aren't broken by the placeholder values shipped in
		// .env.example. Production keeps fail-closed semantics.
		if c.IsDevelopment() {
			log.Warn().Err(err).Msg("weak JWT_SECRET accepted in development; production will reject this value")
		} else {
			return err
		}
	}

	seenIDs := map[string]struct{}{c.JWTSecretID: {}}
	seenSecrets := map[string]struct{}{c.JWTSecret: {}}
	for _, entry := range c.JWTPreviousSecrets {
		if err := validateJWTSecretID(entry.ID); err != nil {
			return fmt.Errorf("invalid JWT_PREVIOUS_SECRETS key ID %q: %w", entry.ID, err)
		}
		if err := validateJWTSecret("JWT_PREVIOUS_SECRETS", entry.Secret); err != nil {
			if c.IsDevelopment() {
				log.Warn().Err(err).Msg("weak JWT_PREVIOUS_SECRETS entry accepted in development")
			} else {
				return err
			}
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
	if c.JWTAccessTTLHours <= 0 {
		return fmt.Errorf("JWT_ACCESS_TTL_HOURS must be positive")
	}
	if c.JWTRefreshTTLDays <= 0 {
		return fmt.Errorf("JWT_REFRESH_TTL_DAYS must be positive")
	}
	// C10 fail-closed: OTP_DEV_MODE accepts the hardcoded dev OTP "999999" for
	// any phone at verify time. Refuse to boot in any non-development env
	// (staging included — not just production) so a single misconfigured env
	// var cannot become a universal account-takeover.
	if !c.IsDevelopment() && c.OTPDevMode {
		return fmt.Errorf("OTP_DEV_MODE must not be true outside development (APP_ENV=%q)", c.Env)
	}
	if !c.IsDevelopment() {
		if c.MessageCentralCustomerID == "" && !c.OTPDevMode {
			return fmt.Errorf("MESSAGECENTRAL_CUSTOMER_ID is required when OTP_DEV_MODE is not true")
		}
		if c.MessageCentralAuthToken == "" && !c.OTPDevMode {
			return fmt.Errorf("MESSAGECENTRAL_AUTH_TOKEN is required when OTP_DEV_MODE is not true")
		}
		if c.JWTRefreshSecret == "" {
			return fmt.Errorf("JWT_REFRESH_SECRET is required in production")
		}
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
	if err := c.validateCashfreePG(); err != nil {
		return err
	}
	return nil
}

// validateCashfreePG enforces all-or-none on the Cashfree PG key set.
// Empty AppID disables the gateway and skips the rest of the checks.
func (c *Config) validateCashfreePG() error {
	if c.CashfreePGAppID == "" &&
		c.CashfreePGSecretKey == "" &&
		c.CashfreePGEnv == "" {
		// Fully unconfigured. Manual fallback path; nothing to validate.
		return nil
	}
	if c.CashfreePGAppID == "" {
		return fmt.Errorf("CASHFREE_PG_APP_ID is required when any CASHFREE_PG_* key is set")
	}
	if c.CashfreePGSecretKey == "" {
		return fmt.Errorf("CASHFREE_PG_SECRET_KEY is required when CASHFREE_PG_APP_ID is set")
	}
	switch c.CashfreePGEnv {
	case "sandbox", "production":
	case "":
		return fmt.Errorf("CASHFREE_PG_ENV is required when CASHFREE_PG_APP_ID is set (sandbox|production)")
	default:
		return fmt.Errorf("CASHFREE_PG_ENV must be 'sandbox' or 'production', got %q", c.CashfreePGEnv)
	}
	if c.CashfreePGWebhookSecret == "" {
		return fmt.Errorf("CASHFREE_PG_WEBHOOK_SECRET is required when CASHFREE_PG_APP_ID is set")
	}
	if c.PublicBaseURL == "" {
		return fmt.Errorf("PUBLIC_BASE_URL is required when CASHFREE_PG_APP_ID is set (used to build the webhook callback URL)")
	}
	if !strings.HasPrefix(c.PublicBaseURL, "https://") {
		return fmt.Errorf("PUBLIC_BASE_URL must start with https:// (Cashfree rejects http:// for webhook URLs), got %q", c.PublicBaseURL)
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

// blockedJWTSecretSubstrings is matched as a substring (case-insensitive)
// against the candidate secret. Substring (not exact) matching is required so
// that placeholder values like the .env example
//
//	"change-this-to-a-random-64-char-string-in-production-XXXXXXXXXXXX"
//
// are rejected even when a developer pads them to clear the 64-char floor.
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
