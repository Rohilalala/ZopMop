package auth

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Realistic 64-char test secrets that pass validateJWTSecret (mix of
// upper/lower/digits/symbols, ≥10 unique chars, visible ASCII).
const (
	activeSecret   = "Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!"
	previousSecret = "Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@Bb2@"
	unknownSecret  = "Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?Zz9?"

	activeKID   = "v2"
	previousKID = "v1"
	bogusKID    = "vX"
)

// signAccess builds an access token with the supplied secret + kid.
// kid="" omits the kid header entirely (rotation fallback path).
func signAccess(t *testing.T, secret, kid string) string {
	t.Helper()
	now := time.Now()
	claims := AccessClaims{
		AdminID:   "00000000-0000-0000-0000-000000000001",
		Email:     "admin@example.com",
		Role:      "admin",
		SessionID: "00000000-0000-0000-0000-000000000002",
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "zopmop-crm",
			Subject:   "00000000-0000-0000-0000-000000000001",
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
			NotBefore: jwt.NewNumericDate(now),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	if kid != "" {
		tok.Header["kid"] = kid
	}
	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("signAccess: %v", err)
	}
	return signed
}

// signChallenge builds a challenge token with the supplied secret + kid.
func signChallenge(t *testing.T, secret, kid string) string {
	t.Helper()
	now := time.Now()
	claims := ChallengeClaims{
		AdminID:     "00000000-0000-0000-0000-000000000001",
		PendingTOTP: true,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "zopmop-crm-challenge",
			Subject:   "00000000-0000-0000-0000-000000000001",
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	if kid != "" {
		tok.Header["kid"] = kid
	}
	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("signChallenge: %v", err)
	}
	return signed
}

func rotationKeys() []JWTKey {
	return []JWTKey{
		{ID: activeKID, Secret: activeSecret},
		{ID: previousKID, Secret: previousSecret},
	}
}

// ── ParseAccessToken ────────────────────────────────────────────────────

func TestParseAccessToken_ActiveSecret(t *testing.T) {
	tok := signAccess(t, activeSecret, activeKID)
	claims, err := ParseAccessToken(tok, rotationKeys())
	if err != nil {
		t.Fatalf("expected verify, got error: %v", err)
	}
	if claims.AdminID != "00000000-0000-0000-0000-000000000001" {
		t.Errorf("unexpected admin_id: %q", claims.AdminID)
	}
}

func TestParseAccessToken_PreviousSecretWithKid(t *testing.T) {
	tok := signAccess(t, previousSecret, previousKID)
	claims, err := ParseAccessToken(tok, rotationKeys())
	if err != nil {
		t.Fatalf("expected previous-secret verify, got error: %v", err)
	}
	if claims.Role != "admin" {
		t.Errorf("unexpected role: %q", claims.Role)
	}
}

func TestParseAccessToken_PreviousSecretNoKidFallback(t *testing.T) {
	// kid omitted → fallback loop tries every key. Token signed with the
	// previous secret should still verify because the loop falls through.
	tok := signAccess(t, previousSecret, "")
	if _, err := ParseAccessToken(tok, rotationKeys()); err != nil {
		t.Fatalf("expected fallback verify, got error: %v", err)
	}
}

func TestParseAccessToken_UnknownSecret(t *testing.T) {
	tok := signAccess(t, unknownSecret, activeKID)
	_, err := ParseAccessToken(tok, rotationKeys())
	if err == nil {
		t.Fatal("expected reject for token signed with unknown secret")
	}
}

func TestParseAccessToken_BogusKid(t *testing.T) {
	// kid present but not in rotation set → must reject WITHOUT falling
	// back to trying every key. A foreign kid is a deterministic routing
	// claim; ambiguity there indicates a stale or forged token.
	tok := signAccess(t, activeSecret, bogusKID)
	_, err := ParseAccessToken(tok, rotationKeys())
	if err == nil {
		t.Fatal("expected reject for token whose kid is not in rotation set")
	}
	if !errors.Is(err, jwt.ErrSignatureInvalid) {
		t.Errorf("expected jwt.ErrSignatureInvalid, got %v", err)
	}
}

func TestParseAccessToken_EmptyKeys(t *testing.T) {
	tok := signAccess(t, activeSecret, activeKID)
	_, err := ParseAccessToken(tok, nil)
	if err == nil {
		t.Fatal("expected error for empty keys slice")
	}
	if !strings.Contains(err.Error(), "no JWT keys configured") {
		t.Errorf("unexpected error message: %v", err)
	}
}

// ── ParseChallengeToken ─────────────────────────────────────────────────
//
// Same shape as ParseAccessToken — verify the rotation behaviour applies
// equally to both parsers.

func TestParseChallengeToken_PreviousSecretWithKid(t *testing.T) {
	tok := signChallenge(t, previousSecret, previousKID)
	claims, err := ParseChallengeToken(tok, rotationKeys())
	if err != nil {
		t.Fatalf("expected previous-secret verify, got error: %v", err)
	}
	if !claims.PendingTOTP {
		t.Error("expected PendingTOTP=true")
	}
}

func TestParseChallengeToken_BogusKid(t *testing.T) {
	tok := signChallenge(t, activeSecret, bogusKID)
	if _, err := ParseChallengeToken(tok, rotationKeys()); err == nil {
		t.Fatal("expected reject for foreign kid")
	}
}
