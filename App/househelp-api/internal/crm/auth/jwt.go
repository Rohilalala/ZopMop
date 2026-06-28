package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// JWTKey is one verification entry in a CRM JWT rotation set. ID is the
// JWT "kid" header value used to route verification to a specific key
// during zero-downtime rotation. Mirrors middleware.JWTKey on the
// user-facing API side (audit NEW-A3-001).
type JWTKey struct {
	ID     string
	Secret string
}

// AccessClaims is the JWT claims shape used by the CRM access token.
type AccessClaims struct {
	AdminID   string `json:"admin_id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	SessionID string `json:"sid"`
	jwt.RegisteredClaims
}

// IssueAccessToken signs a short-lived access token for an admin + session.
func IssueAccessToken(secret, kid, adminID, email, role, sessionID string, ttl time.Duration) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(ttl)

	claims := AccessClaims{
		AdminID:   adminID,
		Email:     email,
		Role:      role,
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "zopmop-crm",
			Subject:   adminID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
			NotBefore: jwt.NewNumericDate(now),
		},
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tok.Header["kid"] = kid

	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign access token: %w", err)
	}
	return signed, exp, nil
}

// ParseAccessToken validates an access token against a rotation key set.
// If the token's header carries a "kid" claim, only the matching key is
// tried (kid-mismatch rejects without a fallback loop). Otherwise every
// key is tried in order until one verifies. Mirrors ParseJWTClaims on
// the user-facing API side (internal/middleware/jwt.go) — audit
// NEW-A3-001.
func ParseAccessToken(tokenStr string, keys []JWTKey) (*AccessClaims, error) {
	if tokenStr == "" {
		return nil, fmt.Errorf("token is required")
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("no JWT keys configured")
	}

	parser := jwt.NewParser(jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))

	candidates, err := selectKeyCandidates(parser, tokenStr, keys)
	if err != nil {
		return nil, err
	}

	var lastErr error
	for _, key := range candidates {
		claims := &AccessClaims{}
		token, err := parser.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(key.Secret), nil
		})
		if err != nil {
			lastErr = err
			continue
		}
		if token != nil && token.Valid {
			if claims.Issuer != "zopmop-crm" {
				return nil, fmt.Errorf("invalid issuer")
			}
			return claims, nil
		}
		lastErr = jwt.ErrSignatureInvalid
	}

	if lastErr == nil {
		lastErr = jwt.ErrSignatureInvalid
	}
	return nil, lastErr
}

// selectKeyCandidates peeks at the token's "kid" header to narrow the
// verification key set. Returns the full set when no kid is present
// (rotation fallback path). Returns an error when kid is set but doesn't
// match any configured key — never falls back, since a kid claim is a
// deterministic routing hint and ambiguity there indicates a forged or
// stale token.
func selectKeyCandidates(parser *jwt.Parser, tokenStr string, keys []JWTKey) ([]JWTKey, error) {
	unverified := jwt.MapClaims{}
	tok, _, err := parser.ParseUnverified(tokenStr, unverified)
	if err != nil {
		return nil, fmt.Errorf("invalid token format: %w", err)
	}
	kid, ok := tok.Header["kid"].(string)
	if !ok || kid == "" {
		return keys, nil
	}
	for _, key := range keys {
		if key.ID == kid {
			return []JWTKey{key}, nil
		}
	}
	return nil, jwt.ErrSignatureInvalid
}

// ChallengeClaims is a short-lived JWT issued after password verification but
// before TOTP. The client must pass it back to /totp/verify; it carries only
// the admin ID and a pending flag, never grants API access on its own.
type ChallengeClaims struct {
	AdminID    string `json:"admin_id"`
	PendingTOTP bool  `json:"pending_totp"`
	jwt.RegisteredClaims
}

// IssueChallengeToken signs a 5-minute pre-TOTP challenge token.
func IssueChallengeToken(secret, kid, adminID string) (string, error) {
	now := time.Now()
	claims := ChallengeClaims{
		AdminID:     adminID,
		PendingTOTP: true,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "zopmop-crm-challenge",
			Subject:   adminID,
			ID:        uuid.NewString(), // jti — recorded on use so a challenge is single-use
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tok.Header["kid"] = kid
	return tok.SignedString([]byte(secret))
}

// ParseChallengeToken validates a challenge token against a rotation key
// set. Same kid-routing semantics as ParseAccessToken (audit NEW-A3-001).
func ParseChallengeToken(tokenStr string, keys []JWTKey) (*ChallengeClaims, error) {
	if tokenStr == "" {
		return nil, fmt.Errorf("token is required")
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("no JWT keys configured")
	}

	parser := jwt.NewParser(jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))

	candidates, err := selectKeyCandidates(parser, tokenStr, keys)
	if err != nil {
		return nil, err
	}

	var lastErr error
	for _, key := range candidates {
		claims := &ChallengeClaims{}
		token, err := parser.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(key.Secret), nil
		})
		if err != nil {
			lastErr = err
			continue
		}
		if token != nil && token.Valid {
			if claims.Issuer != "zopmop-crm-challenge" || !claims.PendingTOTP {
				return nil, fmt.Errorf("invalid challenge token")
			}
			return claims, nil
		}
		lastErr = jwt.ErrSignatureInvalid
	}

	if lastErr == nil {
		lastErr = jwt.ErrSignatureInvalid
	}
	return nil, lastErr
}

// GenerateRefreshToken returns a fresh 32-byte random token + its sha256 hex hash.
// The plaintext is set as the HttpOnly cookie; the hash is what we store.
func GenerateRefreshToken() (plaintext, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("generate refresh token: %w", err)
	}
	plaintext = base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(plaintext))
	hash = hex.EncodeToString(sum[:])
	return plaintext, hash, nil
}

// HashRefreshToken returns the sha256 hex of a refresh-token plaintext.
func HashRefreshToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}
