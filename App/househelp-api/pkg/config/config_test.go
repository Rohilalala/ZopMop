package config

import "testing"

const (
	strongSecretA = "7Qf3#9mL!x2@Pz5$Hn8^Ty1&Uv4*Kr6(As0)Bd3=Gj7+Wq2?Nc5%Re8~Vk1!Zm9@Lp2#Rt5$Wx8&"
	strongSecretB = "1aB@3cD#5eF$7gH%9iJ^2kL&4mN*6pQ(8rS)0tU=2vW+4xY?6zA!8bC~0dE#2fG$4hJ7^kL0*Mn3("
)

func TestValidateJWTSecret_RejectsDefaultSecret(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		secret string
	}{
		{"exact placeholder", "change-this-to-a-random-64-char-string-in-production"},
		// Padded variant from .env.example — must still be rejected because
		// substring matching catches the placeholder regardless of suffix.
		{"padded placeholder", "change-this-to-a-random-64-char-string-in-production-123456789012"},
		{"uppercase variant", "CHANGE-THIS-TO-A-RANDOM-64-CHAR-STRING-IN-PRODUCTION-XXXXXXXXXXXX"},
		{"mysecret padded", "mysecret-mysecret-mysecret-mysecret-mysecret-mysecret-mysecret-x"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if err := validateJWTSecret("JWT_SECRET", tc.secret); err == nil {
				t.Fatalf("expected %q to be rejected", tc.name)
			}
		})
	}
}

func TestValidateJWTSecret_AcceptsStrongSecret(t *testing.T) {
	t.Parallel()

	if err := validateJWTSecret("JWT_SECRET", strongSecretA); err != nil {
		t.Fatalf("expected strong secret to pass validation, got: %v", err)
	}
}

func TestParseJWTPreviousSecrets(t *testing.T) {
	t.Parallel()

	got, err := parseJWTPreviousSecrets("k-1:" + strongSecretA + ",k-2:" + strongSecretB)
	if err != nil {
		t.Fatalf("expected parse success, got: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got[0].ID != "k-1" || got[1].ID != "k-2" {
		t.Fatalf("unexpected key IDs: %+v", got)
	}
}

func TestConfigValidate_RejectsDuplicateRotationKeyID(t *testing.T) {
	t.Parallel()

	cfg := &Config{
		DatabaseURL:        "postgres://x",
		RedisURL:           "redis://x",
		DBPoolMinConns:     5,
		DBPoolMaxConns:     20,
		DBPoolMaxConnLife:  60,
		DBPoolMaxConnIdle:  30,
		DBPoolHealthCheck:  60,
		DBBoundMaxInFlight: 600,
		DBBoundQueueWaitMS: 75,
		JWTSecret:          strongSecretA,
		JWTSecretID:        "active",
		JWTPreviousSecrets: []JWTSecretEntry{
			{ID: "active", Secret: strongSecretB},
		},
		JWTExpiryHours: 24,
	}
	if err := cfg.validate(); err == nil {
		t.Fatalf("expected duplicate key ID validation failure")
	}
}

// prodBaseConfig returns a Config that passes validate() for a production
// environment, so a single toggle can be tested in isolation.
func prodBaseConfig() *Config {
	return &Config{
		Env:                "production",
		DatabaseURL:        "postgres://x",
		RedisURL:           "redis://x",
		JWTSecret:          strongSecretA,
		JWTSecretID:        "active",
		JWTRefreshSecret:   strongSecretB,
		JWTExpiryHours:     24,
		JWTAccessTTLHours:  1,
		JWTRefreshTTLDays:  30,
		MessageCentralCustomerID: "cust",
		MessageCentralAuthToken:  "tok",
		DBPoolMinConns:     5,
		DBPoolMaxConns:     20,
		DBPoolMaxConnLife:  60,
		DBPoolMaxConnIdle:  30,
		DBPoolHealthCheck:  60,
		DBBoundMaxInFlight: 600,
		DBBoundQueueWaitMS: 75,
	}
}

// C10: OTP_DEV_MODE=true in production would let the verify path accept the
// hardcoded dev OTP "999999" for any phone. validate() must refuse to start.
func TestConfigValidate_RejectsOTPDevModeInProduction(t *testing.T) {
	t.Parallel()
	cfg := prodBaseConfig()
	cfg.OTPDevMode = true
	if err := cfg.validate(); err == nil {
		t.Fatalf("expected validate() to reject OTP_DEV_MODE=true in production")
	}
}

// The same flag must remain allowed in development (local/integration flow).
func TestConfigValidate_AllowsOTPDevModeInDevelopment(t *testing.T) {
	t.Parallel()
	cfg := prodBaseConfig()
	cfg.Env = "development"
	cfg.OTPDevMode = true
	if err := cfg.validate(); err != nil {
		t.Fatalf("expected OTP_DEV_MODE=true to be allowed in development, got %v", err)
	}
}
