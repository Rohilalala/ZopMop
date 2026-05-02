package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

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

// ParseAccessToken validates an access token. Returns claims on success.
func ParseAccessToken(tokenStr, secret string) (*AccessClaims, error) {
	parser := jwt.NewParser(jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	claims := &AccessClaims{}
	_, err := parser.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	if claims.Issuer != "zopmop-crm" {
		return nil, fmt.Errorf("invalid issuer")
	}
	return claims, nil
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
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tok.Header["kid"] = kid
	return tok.SignedString([]byte(secret))
}

// ParseChallengeToken validates a challenge token.
func ParseChallengeToken(tokenStr, secret string) (*ChallengeClaims, error) {
	parser := jwt.NewParser(jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	claims := &ChallengeClaims{}
	_, err := parser.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	if claims.Issuer != "zopmop-crm-challenge" || !claims.PendingTOTP {
		return nil, fmt.Errorf("invalid challenge token")
	}
	return claims, nil
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
