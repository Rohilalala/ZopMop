package config

import "testing"

const (
	strongSecretA = "7Qf3#9mL!x2@Pz5$Hn8^Ty1&Uv4*Kr6(As0)Bd3=Gj7+Wq2?Nc5%Re8~Vk1!Zm9@Lp2#Rt5$Wx8&"
	strongSecretB = "1aB@3cD#5eF$7gH%9iJ^2kL&4mN*6pQ(8rS)0tU=2vW+4xY?6zA!8bC~0dE#2fG$4hJ7^kL0*Mn3("
)

func TestValidateJWTSecret_RejectsDefaultSecret(t *testing.T) {
	t.Parallel()

	err := validateJWTSecret("JWT_SECRET", "change-this-to-a-random-64-char-string-in-production")
	if err == nil {
		t.Fatalf("expected default secret to be rejected")
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
