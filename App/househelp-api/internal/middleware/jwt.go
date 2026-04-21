package middleware

import (
	"fmt"

	"github.com/golang-jwt/jwt/v5"
)

// JWTKey contains one signing/verification key and its key ID.
type JWTKey struct {
	ID     string
	Secret string
}

// ParseJWTClaims validates a JWT against the configured key set and returns claims.
// If token header contains "kid", only the matching key is used.
func ParseJWTClaims(tokenString string, keys []JWTKey) (jwt.MapClaims, error) {
	if tokenString == "" {
		return nil, fmt.Errorf("token is required")
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("no JWT keys configured")
	}

	parser := jwt.NewParser(jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))

	// Parse unverified once to inspect header and select key by kid when present.
	unverifiedClaims := jwt.MapClaims{}
	unverifiedToken, _, err := parser.ParseUnverified(tokenString, unverifiedClaims)
	if err != nil {
		return nil, fmt.Errorf("invalid token format: %w", err)
	}

	candidates := keys
	if kid, ok := unverifiedToken.Header["kid"].(string); ok && kid != "" {
		candidates = nil
		for _, key := range keys {
			if key.ID == kid {
				candidates = append(candidates, key)
				break
			}
		}
		if len(candidates) == 0 {
			return nil, jwt.ErrSignatureInvalid
		}
	}

	var lastErr error
	for _, key := range candidates {
		claims := jwt.MapClaims{}
		token, err := parser.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (interface{}, error) {
			// Defense-in-depth in addition to parser valid methods.
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(key.Secret), nil
		})
		if err != nil {
			lastErr = err
			continue
		}
		if token != nil && token.Valid {
			return claims, nil
		}
		lastErr = jwt.ErrSignatureInvalid
	}

	if lastErr == nil {
		lastErr = jwt.ErrSignatureInvalid
	}
	return nil, lastErr
}
