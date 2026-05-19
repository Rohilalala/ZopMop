package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Token issuance + parsing for the post-Firebase MSG91 flow.
//
// Two JWTs are issued per login:
//
//   - Access token. Short-lived (default 1h). Carries the spec claims
//     {uid, typ, phn} + the legacy {user_id, role, is_suspended} pair
//     so any middleware still reading the old shape keeps working
//     during the cut-over (decision: dual-write, not hard cutover).
//
//   - Refresh token. Long-lived (default 30d). Opaque random string
//     stored hashed in the `refresh_tokens` table so /logout can
//     revoke it server-side. The string itself is NOT a JWT — it's
//     base64url(32 random bytes) so we never have to worry about
//     leaking refresh-secret material in a parseable token.
//
// Access tokens are signed with JWT_ACCESS_SECRET (falls back to the
// existing JWT_SECRET in dev for continuity with old code paths).
// Refresh tokens are random bytes; JWT_REFRESH_SECRET is kept in the
// config for future symmetric-MAC tagging but is not used to sign the
// opaque value itself.

const (
	defaultAccessTokenTTL  = time.Hour
	defaultRefreshTokenTTL = 30 * 24 * time.Hour
)

// TokenIssuerConfig wires the issuer with its signing material and
// TTLs. Zero TTLs fall back to defaults above.
type TokenIssuerConfig struct {
	AccessSecret   string
	AccessSecretID string
	AccessTTL      time.Duration
	RefreshTTL     time.Duration
}

// TokenIssuer mints access + refresh tokens. Stateless — safe to
// share across goroutines.
type TokenIssuer struct {
	cfg TokenIssuerConfig
}

// NewTokenIssuer constructs an issuer. Panics if AccessSecret is
// empty — a deploy without a signing secret must fail loud, not
// silently issue forgeable tokens.
func NewTokenIssuer(cfg TokenIssuerConfig) *TokenIssuer {
	if cfg.AccessSecret == "" {
		panic("auth.NewTokenIssuer: AccessSecret must not be empty")
	}
	if cfg.AccessTTL == 0 {
		cfg.AccessTTL = defaultAccessTokenTTL
	}
	if cfg.RefreshTTL == 0 {
		cfg.RefreshTTL = defaultRefreshTokenTTL
	}
	return &TokenIssuer{cfg: cfg}
}

// AccessTTL exposes the configured access-token lifetime so the
// handler can set a matching Max-Age on the auth cookie.
func (t *TokenIssuer) AccessTTL() time.Duration { return t.cfg.AccessTTL }

// RefreshTTL exposes the refresh-token lifetime so the repository
// can persist a matching expires_at row.
func (t *TokenIssuer) RefreshTTL() time.Duration { return t.cfg.RefreshTTL }

// IssueAccessToken mints a JWT with both the new spec claims
// {uid, typ, phn} and the legacy {user_id, role, is_suspended}
// claims. typ is mapped from role: "pro" → "pro", anything else →
// "customer". The middleware can populate both old and new locals
// from the same token.
func (t *TokenIssuer) IssueAccessToken(userID, role, phone string, isSuspended bool) (string, error) {
	if userID == "" {
		return "", errors.New("userID required")
	}
	typ := UserTypeFromRole(role)
	now := time.Now()

	claims := jwt.MapClaims{
		// Spec claims.
		"uid": userID,
		"typ": typ,
		"phn": phone,
		// Legacy claims for backwards-compatible middleware reads.
		"user_id":      userID,
		"role":         role,
		"is_suspended": isSuspended,
		// Standard timing.
		"iss": "zopmop-api",
		"iat": now.Unix(),
		"exp": now.Add(t.cfg.AccessTTL).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	if t.cfg.AccessSecretID != "" {
		token.Header["kid"] = t.cfg.AccessSecretID
	}
	signed, err := token.SignedString([]byte(t.cfg.AccessSecret))
	if err != nil {
		return "", fmt.Errorf("sign access token: %w", err)
	}
	return signed, nil
}

// IssueRefreshToken returns an opaque refresh token (returned to the
// client) alongside its SHA-256 hash (stored in DB). The plaintext is
// returned ONLY here; subsequent rotations / revocations key off the
// hash. base64url-no-pad over 32 random bytes yields a 43-char token
// that fits comfortably in a header / SecureStore.
func (t *TokenIssuer) IssueRefreshToken() (plaintext, hash string, expiresAt time.Time, err error) {
	buf := make([]byte, 32)
	if _, rerr := rand.Read(buf); rerr != nil {
		return "", "", time.Time{}, fmt.Errorf("generate refresh entropy: %w", rerr)
	}
	plaintext = base64.RawURLEncoding.EncodeToString(buf)
	hash = HashRefreshToken(plaintext)
	expiresAt = time.Now().Add(t.cfg.RefreshTTL)
	return plaintext, hash, expiresAt, nil
}

// HashRefreshToken is the canonical SHA-256-hex hash used to look up
// a refresh token row. Exported so the repository can use the same
// transform on both the insert (plaintext from IssueRefreshToken) and
// the lookup (plaintext from the client).
func HashRefreshToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// UserTypeFromRole maps the legacy users.role column to the spec's
// user_type vocabulary. Anything other than "pro" collapses to
// "customer" — admins included, since they sign in via the CRM JWT
// flow, not this user JWT.
func UserTypeFromRole(role string) string {
	if role == "pro" {
		return "pro"
	}
	return "customer"
}
