package middleware

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	testSecretCurrent = "7Qf3#9mL!x2@Pz5$Hn8^Ty1&Uv4*Kr6(As0)Bd3=Gj7+Wq2?Nc5%Re8~Vk1!Zm9@Lp2#Rt5$Wx8&"
	testSecretOld     = "1aB@3cD#5eF$7gH%9iJ^2kL&4mN*6pQ(8rS)0tU=2vW+4xY?6zA!8bC~0dE#2fG$4hJ7^kL0*Mn3("
)

func signTestToken(t *testing.T, userID, keyID, secret string) string {
	t.Helper()

	claims := jwt.MapClaims{
		"user_id": userID,
		"role":    "customer",
		"iat":     time.Now().Unix(),
		"exp":     time.Now().Add(time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	if keyID != "" {
		token.Header["kid"] = keyID
	}
	signed, err := token.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("failed to sign token: %v", err)
	}
	return signed
}

func TestParseJWTClaims_UsesCurrentKey(t *testing.T) {
	t.Parallel()

	keys := []JWTKey{
		{ID: "active", Secret: testSecretCurrent},
		{ID: "old", Secret: testSecretOld},
	}
	token := signTestToken(t, "user-1", "active", testSecretCurrent)

	claims, err := ParseJWTClaims(token, keys)
	if err != nil {
		t.Fatalf("expected token to validate, got error: %v", err)
	}
	if got, _ := claims["user_id"].(string); got != "user-1" {
		t.Fatalf("expected user_id user-1, got %q", got)
	}
}

func TestParseJWTClaims_UsesPreviousKey(t *testing.T) {
	t.Parallel()

	keys := []JWTKey{
		{ID: "active", Secret: testSecretCurrent},
		{ID: "old", Secret: testSecretOld},
	}
	token := signTestToken(t, "user-old", "old", testSecretOld)

	claims, err := ParseJWTClaims(token, keys)
	if err != nil {
		t.Fatalf("expected previous key token to validate, got error: %v", err)
	}
	if got, _ := claims["user_id"].(string); got != "user-old" {
		t.Fatalf("expected user_id user-old, got %q", got)
	}
}

func TestParseJWTClaims_RejectsUnknownKid(t *testing.T) {
	t.Parallel()

	keys := []JWTKey{{ID: "active", Secret: testSecretCurrent}}
	token := signTestToken(t, "user-1", "unknown", testSecretCurrent)

	if _, err := ParseJWTClaims(token, keys); err == nil {
		t.Fatalf("expected unknown kid token to fail")
	}
}
